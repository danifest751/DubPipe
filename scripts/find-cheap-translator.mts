/**
 * Подбор дешёвой модели перевода для конкретного языка оригинала.
 *
 * Каталог шлюза знает цены, но не знает, справится ли модель с языком. Скрипт
 * берёт самые дешёвые модели, даёт каждой одни и те же фразы и показывает, что
 * получилось: цену прогона, время и сам перевод — оценивать качество должен
 * человек, автоматика проверяет только очевидное (ответ есть, он по-русски).
 *
 * Запуск:
 *   npx tsx scripts/find-cheap-translator.mts ko            # бесплатные и самые дешёвые
 *   npx tsx scripts/find-cheap-translator.mts ko --limit 8  # сколько моделей пробовать
 */
import { loadConfig } from '../src/config/load.js';
import { languageProfile } from '../src/core/languages.js';
import { makeSegment } from '../src/core/types.js';
import { estimateCost, loadCatalog, type CatalogModel } from '../src/providers/llm/catalog.js';
import { KiloGatewayClient } from '../src/providers/llm/index.js';
import { translateSegments } from '../src/stages/s3-translate.js';

/** Свои фразы с известным смыслом — чтобы оценить не только форму, но и точность. */
const SAMPLES: Record<string, Array<{ text: string; seconds: number; meaning: string }>> = {
  ko: [
    { text: '안녕하세요. 오늘 회의는 몇 시에 시작해요?', seconds: 3.2, meaning: 'Здравствуйте. Во сколько сегодня начинается совещание?' },
    { text: '세 시예요. 자료는 이미 보냈어요.', seconds: 2.6, meaning: 'В три. Материалы я уже отправил.' },
    { text: '미안하지만 조금 늦을 것 같아요.', seconds: 2.6, meaning: 'Извините, кажется, я немного опоздаю.' },
    { text: '걱정하지 마세요. 제가 대신 설명할게요.', seconds: 3.0, meaning: 'Не волнуйтесь. Я объясню вместо вас.' },
  ],
  zh: [
    { text: '你好，今天的会议几点开始？', seconds: 3.0, meaning: 'Здравствуйте, во сколько сегодня начинается совещание?' },
    { text: '三点。资料我已经发过去了。', seconds: 2.6, meaning: 'В три. Материалы я уже отправил.' },
  ],
};

const code = (process.argv[2] ?? 'ko').toLowerCase();
const samples = SAMPLES[code];
if (!samples) {
  console.error(`Нет образцов для «${code}». Доступны: ${Object.keys(SAMPLES).join(', ')}`);
  process.exit(2);
}
const limitIndex = process.argv.indexOf('--limit');
const limit = limitIndex > 0 ? Number(process.argv[limitIndex + 1]) : 10;
// --paid: бесплатные пропускаем. У них жёсткие ограничения по частоте запросов,
// и на нескольких сотнях реплик прогон растягивается на часы.
const paidOnly = process.argv.includes('--paid');

const { config } = await loadConfig();
const profile = languageProfile(code);
const runConfig = {
  ...config,
  asr: { ...config.asr, language: code },
  // Один запрос на прогон и никакого корректирующего прохода: сравниваем модели,
  // а не работу конвейера.
  translate: { ...config.translate, fit_length_pass: false, batch_size: 10 },
  kilo_gateway: { ...config.kilo_gateway, max_retries: 1, timeout_ms: 90_000 },
};

const catalog = await loadCatalog(config);
const price = (model: CatalogModel) => model.promptPrice + model.completionPrice;
const candidates = catalog
  .filter((model) => !/(^|\/)(.*-)?(image|vision|embed|tts|whisper|audio)/i.test(model.id))
  .filter((model) => (paidOnly ? !model.free && price(model) > 0 : true))
  .sort((a, b) => (paidOnly ? 0 : Number(b.free) - Number(a.free)) || price(a) - price(b))
  .slice(0, limit);

console.log(`Язык: ${profile.name}. Проверяю ${candidates.length} моделей из ${catalog.length}.\n`);

const CYRILLIC = /[а-яё]/i;
const HANGUL = /[가-힣]/;
const results: Array<{ id: string; free: boolean; cost: number | null; seconds: number; verdict: string; lines: string[] }> = [];

for (const model of candidates) {
  const label = `${model.id}${model.free ? ' (бесплатная)' : ` ($${(price(model) * 1e6).toFixed(2)}/млн)`}`;
  process.stdout.write(`→ ${label}\n`);
  const client = await KiloGatewayClient.create(runConfig, model.id);
  if (!client) {
    console.log('   ключ шлюза не задан\n');
    break;
  }
  const segments = samples.map((sample, index) =>
    makeSegment({ id: index, start: index * 5, end: index * 5 + sample.seconds, text_en: sample.text }),
  );
  const started = Date.now();
  try {
    const run = await translateSegments(client, runConfig, segments);
    const lines = run.segments.map((segment) => segment.text_ru ?? '');
    const missing = lines.filter((line) => !line.trim()).length;
    const foreign = lines.filter((line) => line.trim() && !CYRILLIC.test(line)).length;
    const untouched = lines.filter((line) => HANGUL.test(line)).length;
    const verdict =
      missing > 0 ? `перевела ${lines.length - missing} из ${lines.length}`
      : untouched > 0 ? 'вернула корейский текст'
      : foreign > 0 ? 'ответ не по-русски'
      : 'переводит';
    results.push({
      id: model.id,
      free: model.free,
      cost: estimateCost(model, run.usage) ?? run.usage.cost ?? null,
      seconds: (Date.now() - started) / 1000,
      verdict,
      lines,
    });
    for (const [index, line] of lines.entries()) console.log(`   ${line || '—'}   (ожидалось: ${samples[index]!.meaning})`);
    console.log(`   ${verdict}, ${((Date.now() - started) / 1000).toFixed(1)} с\n`);
  } catch (error) {
    console.log(`   не ответила: ${(error as Error).message.split('\n')[0]?.slice(0, 90)}\n`);
    results.push({ id: model.id, free: model.free, cost: null, seconds: (Date.now() - started) / 1000, verdict: 'ошибка', lines: [] });
  }
}

console.log('\nСводка (пригодные — сверху):');
const ok = results.filter((item) => item.verdict === 'переводит');
const bad = results.filter((item) => item.verdict !== 'переводит');
for (const item of [...ok, ...bad]) {
  const cost = item.cost != null ? `$${item.cost.toFixed(5)}` : '—';
  console.log(`  ${item.verdict === 'переводит' ? '✓' : '✗'} ${item.id.padEnd(48)} ${cost.padEnd(10)} ${item.seconds.toFixed(1)} с  ${item.verdict}`);
}
