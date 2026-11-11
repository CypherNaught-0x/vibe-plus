use std::collections::HashMap;

use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use whisper_rs::TranscribeOptions;

use crate::audio;
use crate::cli::AppConfig;
use crate::server::diarization;
use crate::server::form::FormValues;
use crate::server::stream::{stream_transcription, StreamInput};
use crate::server::unload_timeout::ModelLease;
use crate::server::{error, format, TextResponse};

/// The uploaded audio. A `no_audio_storage` request keeps it in memory so it never touches the disk.
pub(super) enum Upload {
    /// On disk; deleted when this drops.
    Disk(tempfile::TempPath),
    Memory(Vec<u8>),
}

impl Upload {
    /// Decode and release the upload: the samples are all that is needed from here on, so the
    /// disk (or memory) is freed now rather than after a transcription as long as the audio.
    pub fn decode(self, options: audio::ReadOptions) -> anyhow::Result<Vec<f32>> {
        match self {
            Self::Disk(path) => audio::read_file_with_options(&path, options),
            Self::Memory(bytes) => audio::read_bytes_in_memory(bytes, options),
        }
    }
}

pub(super) struct TranscriptionRequest {
    pub file: Upload,
    pub form: HashMap<String, String>,
}

pub(super) async fn transcribe(
    config: AppConfig,
    mut model: ModelLease,
    request: TranscriptionRequest,
) -> Result<Response, Response> {
    let TranscriptionRequest { file, form } = request;
    let (diarize, diarize_model, enhance_audio, stable_timestamps, vad_model_path, stream, response_format) = {
        let values = FormValues::new(&form);
        (
            values.bool("diarize"),
            values.string("diarize_model"),
            values.bool("enhance_audio"),
            values.bool("stable_timestamps"),
            values.string("vad_model"),
            values.bool("stream"),
            values.str_or("response_format", "json").to_string(),
        )
    };
    let audio_options = audio::ReadOptions {
        enhance_audio,
        verbose: config.verbose(),
    };
    let capabilities = model.ctx.as_ref().map(|ctx| ctx.capabilities());
    let speakers = Speakers::choose(diarize, diarize_model, capabilities.as_ref());
    // An engine that times words itself has no use for the VAD pass; a client that still
    // asks for it gets the engine's own timings rather than an error.
    let stable_timestamps = stable_timestamps && capabilities.as_ref().is_none_or(|caps| caps.stable_timestamps);
    let native = speakers == Speakers::Native;
    let diarize_model = match speakers {
        Speakers::External(model_path) => Some(model_path),
        Speakers::Off | Speakers::Native => None,
    };

    if stable_timestamps && vad_model_path.is_none() {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "'vad_model' is required when 'stable_timestamps' is true",
        ));
    }

    // A streamed request answers at once and reports the slow steps before the
    // first word (decoding the audio, diarization) as stage events, so the
    // caller is not left looking at nothing for minutes on a long file.
    if stream {
        return stream_transcription(
            config,
            model,
            StreamInput {
                file,
                audio_options,
                diarize_model,
            },
            form,
            stable_timestamps,
            vad_model_path,
            native,
        )
        .map_err(|err| *err);
    }

    let samples = file.decode(audio_options).map_err(|err| {
        let (status, code, message) = audio_error(&err);
        error(status, code, &message)
    })?;

    let diar_segments = diarize_model
        .as_deref()
        .map_or_else(Vec::new, |model_path| diarization::diarize(model_path, &samples));

    let verbose = config.verbose();
    let ctx = model
        .ctx
        .as_mut()
        .ok_or_else(|| error(StatusCode::SERVICE_UNAVAILABLE, "no_model", "no model loaded"))?;

    if ctx.requires_vad() && vad_model_path.is_none() {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "'vad_model' is required for this transcription engine",
        ));
    }

    let opts = build_options(
        &form,
        verbose,
        stable_timestamps,
        vad_model_path,
        !diar_segments.is_empty(),
        native,
    );
    let result = ctx.transcribe(&samples, opts).map_err(|err| {
        tracing::error!(samples = samples.len(), "transcription failed: {err:#}");
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            super::engine_error_code(&err),
            &format!("transcription failed: {err}"),
        )
    })?;

    Ok(format_response(&response_format, &result, &diar_segments))
}

/// How a failed decode is reported. ffmpeg that is missing or cannot be started is the
/// server's problem, not the file's, so it is not called "invalid audio".
pub(super) fn audio_error(err: &anyhow::Error) -> (StatusCode, &'static str, String) {
    if err.downcast_ref::<audio::FfmpegError>().is_some() {
        // The error already names its io cause; `{err:#}` would print it twice.
        tracing::error!("{err}");
        (StatusCode::INTERNAL_SERVER_ERROR, "internal_error", err.to_string())
    } else {
        (StatusCode::BAD_REQUEST, "invalid_audio", format!("invalid audio file: {err}"))
    }
}

/// Where a request's speakers come from.
#[derive(Debug, PartialEq)]
pub(super) enum Speakers {
    Off,
    /// The engine labels speakers itself; no diarization model is loaded.
    Native,
    /// A separate diarization model at this path, attributed by word timings.
    External(String),
}

impl Speakers {
    /// `diarize` or a `diarize_model` asks for speakers. An engine with its own diarization
    /// answers that itself, so the separate model is never loaded for it.
    pub(super) fn choose(
        diarize: bool,
        diarize_model: Option<String>,
        capabilities: Option<&crate::engine::EngineCapabilities>,
    ) -> Self {
        if !diarize && diarize_model.is_none() {
            return Self::Off;
        }
        if capabilities.is_some_and(|caps| caps.native_diarization) {
            return Self::Native;
        }
        diarize_model.map_or(Self::Off, Self::External)
    }
}

/// Every engine times its words on every run, and speaker attribution splits
/// segments on them. `word_timestamps` only decides whether whisper also wraps
/// segments to `max_segment_len`; a diarized request has always turned it on.
/// `native_diarization` asks an engine with its own diarization to label speakers.
pub(super) fn build_options(
    form: &HashMap<String, String>,
    verbose: bool,
    stable_timestamps: bool,
    vad_model_path: Option<String>,
    diarized: bool,
    native_diarization: bool,
) -> TranscribeOptions {
    let values = FormValues::new(form);
    TranscribeOptions {
        language: values.string("language"),
        detect_language: values.bool("detect_language"),
        translate: values.bool("translate"),
        threads: values.i32("n_threads"),
        prompt: values.string("prompt"),
        verbose,
        temperature: values.f32("temperature"),
        max_text_ctx: values.i32("max_text_ctx"),
        word_timestamps: diarized || values.bool("word_timestamps"),
        max_segment_len: values.i32("max_segment_len"),
        sampling_greedy: form.get("sampling_strategy").is_none_or(|strategy| strategy != "beam_search"),
        best_of: values.i32("best_of"),
        beam_size: values.i32("beam_size"),
        stable_timestamps,
        vad_model_path,
        diarize: native_diarization,
    }
}

fn format_response(
    response_format: &str,
    result: &whisper_rs::TranscribeResult,
    diar_segments: &[diarization::Segment],
) -> Response {
    match response_format {
        "verbose_json" => Json(format::build_verbose_json(result, diar_segments)).into_response(),
        "text" => ([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], result.text()).into_response(),
        "srt" => (
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            format::format_srt(&result.segments),
        )
            .into_response(),
        "vtt" => (
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            format::format_vtt(&result.segments),
        )
            .into_response(),
        _ => Json(TextResponse { text: result.text() }).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps(native_diarization: bool) -> crate::engine::EngineCapabilities {
        crate::engine::EngineCapabilities {
            native_diarization,
            ..crate::engine::whisper_capabilities()
        }
    }

    #[test]
    fn a_native_engine_answers_speakers_without_the_diarization_model() {
        let model = || Some("/models/diar.gguf".to_owned());
        assert_eq!(Speakers::choose(false, model(), Some(&caps(true))), Speakers::Native);
        assert_eq!(Speakers::choose(true, None, Some(&caps(true))), Speakers::Native);
        assert_eq!(Speakers::choose(false, None, Some(&caps(true))), Speakers::Off);
    }

    #[test]
    fn other_engines_keep_the_diarization_model() {
        let model = || Some("/models/diar.gguf".to_owned());
        assert_eq!(
            Speakers::choose(false, model(), Some(&caps(false))),
            Speakers::External("/models/diar.gguf".to_owned())
        );
        assert_eq!(
            Speakers::choose(false, model(), None),
            Speakers::External("/models/diar.gguf".to_owned())
        );
        // `diarize` alone names no model for an engine that needs one.
        assert_eq!(Speakers::choose(true, None, Some(&caps(false))), Speakers::Off);
    }
}
