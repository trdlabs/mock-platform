# Аудит mock-platform — локальный roadmap-срез (2026-07-18)

Канонический cross-repo статус — в control-center
[initiative registry](../../../control-center/docs/delivery/cross-repo-initiatives.md):
карточки
[mock-contract-parity](../../../control-center/docs/delivery/initiatives/mock-contract-parity.md)
и
[wfo-extended-fixture](../../../control-center/docs/delivery/initiatives/wfo-extended-fixture.md).
Здесь — только локальная часть mock-platform (правило registry: без
дублирования плана).

Полный аудит: control-center
[`docs/analysis/09-mock-platform-audit.md`](../../../control-center/docs/analysis/09-mock-platform-audit.md).

## mock-contract-parity — локальная часть закрыта

Все пункты, за которые отвечал mock-platform, сделаны. Канонический статус
инициативы — в карточке (ссылка выше); здесь только локальный срез.

- ✅ `/historical/rows`: полуоткрытый диапазон `[fromMs, toMs)` (P0-1) и
  глобальный порядок `(minute_ts ASC, symbol ASC)` при multi-symbol запросе
  (P1-1). Golden-фикстура получила второй символ (`ETHUSDT`), а conformance-тест
  падает на любом непустом skip-списке — иначе ordering-кейс «проходил» скипом.
- ✅ Bars-only снапшоты (P1-2): строки отдаются только из minute-grain источника,
  иначе `rows: unavailable` в discover и `404 minute_rows_unavailable`. Гвард
  привязан к запросу, а не к снапшоту: смешанный снапшот не может ответить
  пустой страницей на запрос coarse-only символа.
- ✅ Пин на `@trdlabs/sdk` (точная npm-версия) вместо legacy
  `@trading-platform/sdk`-tarball; vendored harness удалён, conformance идёт из
  `@trdlabs/sdk/conformance`. Гейты: `verify:sdk-pin` (точность пина + `ops.6` +
  наличие `/conformance`), `verify:golden-sync` (platform-owned golden остаётся
  vendored — SDK им не владеет).
- ✅ Док-дрейф: `docs/contracts/snapshot-format.md` (13 top-level ключей, пример
  `ops.6`), `/ops/runs/:id/analysis` помечен как mock-only, расхождение
  error-shape по historical задокументировано осознанно.

## wfo-extended-fixture — локальная часть закрыта (`implementing` в целом)

Всё, за что отвечал mock-platform (items 1, 3, 5), смержено в `main` (#39, `70b2d5f`).
Инициатива остаётся `implementing`: впереди items 2/6 (SSOT tier table и docs в
control-center) и item 4 (выбор тира у lab / backtester). Канонический статус — в карточке.

- ✅ Fetch + commit **`data/snapshots/wfo/2026-06-09-to-2026-07-20-vps-wfo42d`** — отдельный
  корень `wfo/`, а не `fixtures/`: у него своя политика (там отсутствие sidecar — FAIL,
  в legacy `fixtures/` — WARN). 5 символов × 59 893 общих минуты, native 1m, gz-бандл 27 MB.
  Символы выбраны детерминированно по обороту, ranking записан в `provenance.json`.
- ✅ Integrity/coverage-validator: декларация живёт в **строгом sidecar
  `coverage.json` (`fixture-coverage.1`)**, а не в manifest. `snapshot.1`, его AJV-схема,
  `manifest.ts`, `compat.ts` и загрузчик не тронуты — manifest-схема
  `additionalProperties:false` на обоих уровнях и `compat.ts` точный, так что любое новое
  поле там заставило бы каждый старый ридер отвергнуть новый manifest. Coverage — это
  политика допуска в CI *про* снапшот, рантайм её не читает.
  Sidecar объявляет `period` / `symbols` / `barTimeframes` / оба gap-бюджета; `verify:fixtures`
  сверяет с фактическим содержимым бандла и держит производные поверхности тоже: funding/OI/
  ликвидации внутри окна, набор timeframe совпадает с `barTimeframes` точно, каждый бар
  пересобран из минутных строк и сверен по всем пяти полям OHLCV, `tsMs` уникальны и строго
  возрастают.
- ✅ Code-default `MOCK_SNAPSHOT_REF` (`src/access/config.ts`) уведён с
  `2026-06-16-synthetic` (данные 2024 года, bars-only) на T1.
- ⏭️ Ecosystem default `snapshot_ref` намеренно остаётся T1 — продвижение T2 это отдельный
  rollout, не часть этой инициативы.
- ⏭️ Фикстура **не** попадает в demo-образ (`.dockerignore`); CI это утверждает отдельным
  шагом, дельта образа +144 962 B.

Auth на `/historical/*` — в карточке
[security-edge-hardening](../../../control-center/docs/delivery/initiatives/security-edge-hardening.md)
(item 10), здесь не дублируется.
