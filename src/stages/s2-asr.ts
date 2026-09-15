import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import type { DubConfig } from '../config/schema.js';
import { log } from '../core/logger.js';
import { warn, type Segment, type StageWarning } from '../core/types.js';
import type { Workspace } from '../core/workspace.js';
import { createAsrProvider } from '../providers/asr/index.js';
import {
  assignSpeakers,
  cachedTurns,
  diarize,
  diarizationFingerprint,
  probeDiarization,
  speakerNames,
} from '../providers/diarization/pyannote.js';
import { profileSpeakers, type SpeechInterval } from '../providers/diarization/gender.js';
import { message } from '../core/i18n.js';
import { detectSpeech, snapToSpeech, type SpeechRegion } from '../providers/vad/silero.js';
import { toSrt } from '../util/srt.js';
import { buildSegments, segmentsSummary, type RawSegment } from './s2-segments.js';

/**
 * S2 — speech recognition with timecodes and speakers (SPEC FR-2).
 * Produces: segments.json, transcript.srt, speech.json (windows reused by S7).
 */

export interface S2Result {
  segments: Segment[];
  provider: string;
  warnings: StageWarning[];
  noSpeech: boolean;
  speechRegions: SpeechRegion[];
}

export async function runS2(workspace: Workspace, config: DubConfig, audioPath: string): Promise<S2Result> {
  const warnings: StageWarning[] = [];
  const provider = createAsrProvider(workspace, config);
  const asr = await provider.transcribe(audioPath);
  warnings.push(...asr.warnings);

  let raw: RawSegment[] = asr.segments;
  let speechRegions: SpeechRegion[] = [];
  let refinedByVad = false;

  if (config.asr.vad.enabled) {
    log.progress('уточнение границ по речи (VAD)', null, null, { key: 'work.vad' });
    // whisper stretches the last word of a replica up to the next one, so the
    // ends need real speech edges to land inside ±250 ms (SPEC FR-2).
    const vadInput = workspace.file('audio16k.wav');
    try {
      speechRegions = await detectSpeech(existsSync(vadInput) ? vadInput : audioPath, workspace.modelsDir);
      raw = raw.map((segment) => ({ ...segment, ...snapToSpeech(segment, speechRegions, config.asr.vad.window_ms) }));
      refinedByVad = true;
      await workspace.writeJson(workspace.file('speech.json'), speechRegions);
      log.step(`VAD: речевых окон ${speechRegions.length}`);
    } catch (error) {
      const reason = (error as Error).message;
      warnings.push(
        warn(
          'warn.s2.vad',
          `Уточнение границ по VAD не выполнено (${reason}); границы реплик могут выходить за ±250 мс (ТЗ FR-2)`,
          { reason },
        ),
      );
    }
  }

  let segments = buildSegments(raw, {
    // Word timings would re-inflate the ends that VAD has just corrected.
    vadWindowMs: refinedByVad ? 0 : config.asr.vad.window_ms,
  });

  // Интервалы речи каждого спикера — для оценки пола голоса ниже.
  let speechBySpeaker: SpeechInterval[] | null = null;

  // Диаризация — внешний Python-процесс (pyannote). Любая неполадка
  // допустима, но обязана попасть в отчёт (ТЗ FR-2, §12.2).
  if (config.asr.diarization.enabled && config.asr.diarization.engine !== 'none' && segments.length > 0) {
    const probe = await probeDiarization(config, workspace.modelsDir);
    if (!probe.available) {
      const reason = message(probe.reason ?? '', 'ru');
      const hint = message(probe.hint ?? '', 'ru');
      warnings.push(
        warn(
          'warn.s2.diarizationSkipped',
          `Диаризация пропущена (${reason}): все реплики помечены speaker_0, ` +
            `назначение голосов по спикерам работать не будет. ${hint}`,
          { reason, hint },
        ),
      );
    } else {
      log.step(`диаризация моделью ${config.asr.diarization.model} (Python + PyTorch)`);
      log.progress('диаризация: загрузка модели', null, null, { key: 'work.diarizeLoad' });
      try {
        const diarizationInput = workspace.file('audio16k.wav');
        const diarizationFile = workspace.file('diarization.json');
        const fingerprint = diarizationFingerprint(
          workspace.inputHash,
          config.asr.diarization.model,
          config.asr.diarization.max_speakers,
        );
        // Готовый разбор по говорящим годится, если он от этой же записи:
        // распознавание могли перезапустить другой моделью, а звук не менялся.
        const reused = existsSync(diarizationFile)
          ? cachedTurns(JSON.parse(readFileSync(diarizationFile, 'utf8')), fingerprint)
          : null;
        if (reused) log.step('диаризация взята из кэша: звук и настройки те же');
        const turns =
          reused ??
          (await diarize(
            config,
            workspace.modelsDir,
            existsSync(diarizationInput) ? diarizationInput : audioPath,
            diarizationFile,
            fingerprint,
          ));
        const before = segments.length;
        segments = assignSpeakers(segments, turns);
        const names = speakerNames(turns);
        speechBySpeaker = turns.map((turn) => ({ ...turn, speaker: names.get(turn.speaker) ?? turn.speaker }));
        const split = segments.length - before;
        log.step(`спикеров найдено: ${new Set(turns.map((t) => t.speaker)).size}` + (split > 0 ? `, реплик разделено по смене говорящего: ${split}` : ''));
      } catch (error) {
        const failure = (error as Error).message;
        warnings.push(
          warn('warn.s2.diarizationFailed', `Диаризация не удалась (${failure}): все реплики помечены speaker_0`, {
            reason: failure,
          }),
        );
      }
    }
  }

  const noSpeech = segments.length === 0;
  if (noSpeech) {
    warnings.push('Речь не обнаружена — итог будет копией входа (ТЗ §8)');
  }

  // Пол голоса каждого спикера по основному тону — чтобы мужчине не достался
  // женский голос по умолчанию (ТЗ FR-5). Без диаризации оценивается единственный
  // спикер по репликам. Ошибка здесь не должна валить стадию.
  if (!noSpeech) {
    log.progress('оценка пола голосов', null, null, { key: 'work.gender' });
    try {
      const intervals = speechBySpeaker ?? segments.map((segment) => ({ start: segment.start, end: segment.end, speaker: segment.speaker }));
      const analysis = workspace.file('audio16k.wav');
      const profiles = await profileSpeakers(existsSync(analysis) ? analysis : audioPath, intervals);
      await workspace.writeSpeakers(Object.fromEntries(profiles));
      const summary = [...profiles]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([speaker, profile]) => `${speaker} ${profile.gender}${profile.f0 ? ` (${profile.f0} Гц)` : ''}`)
        .join(', ');
      log.step(`пол голосов: ${summary}`);
    } catch (error) {
      warnings.push(`Пол голосов не определён (${(error as Error).message}): голоса по полу назначаться не будут`);
    }
  }

  await workspace.writeSegments(segments);
  await writeFile(workspace.file('transcript.srt'), toSrt(segments, 'en'), 'utf8');

  const summary = segmentsSummary(segments);
  log.step(
    `реплик: ${summary.count}, речи: ${summary.speechSeconds} с, спикеров: ${summary.speakers.length}` +
      (summary.overlaps ? `, перекрытий: ${summary.overlaps}` : ''),
  );

  return { segments, provider: asr.provider, warnings, noSpeech, speechRegions };
}
