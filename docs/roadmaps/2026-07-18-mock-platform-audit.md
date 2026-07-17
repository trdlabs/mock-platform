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

## mock-contract-parity — `proposed`

- `/historical/rows`: полуоткрытый диапазон `[fromMs, toMs)` вместо
  инклюзивного по обоим концам (`src/snapshot/readers/rows.ts:17-20`) — P0-1;
  фикс только после того, как в sdk-harness появится красный boundary-кейс.
- Глобальный порядок `(minute_ts ASC, symbol ASC)` при multi-symbol запросе
  вместо конкатенации по символам (`src/historical/handlers/rows.ts:25-32`).
- Bars-only снапшоты: не отдавать синтезированные часовые строки как минутные
  без маркера (`src/snapshot/readers/rows-from-perkind.ts:78-135`) —
  `rows: unavailable` либо явный provenance-флаг.
- Миграция пина на `@trdlabs/sdk` (npm) с legacy `@trading-platform/sdk`
  0.9.3 tarball; harness — из репо sdk (сейчас vendored-копия из platform,
  гейт `scripts/verify_harness_sync.mjs`).
- Док-дрейф: `docs/contracts/snapshot-format.md` (13 фактических top-level
  ключей vs 11 задокументированных, пример `ops.3` → `ops.6`);
  `/ops/runs/:id/analysis` пометить как mock-only поверхность.

## wfo-extended-fixture — `proposed`

- Fetch + commit `fixtures/<from>-to-<to>-vps-wfo42d`: 42 дня подряд, native
  1m, primary + top-3–5 символов, `--trim-scope historical`, gz-бандл
  (~20–25 MB; экстраполяция от default: 0.79 MB raw на символ-день).
- Integrity/coverage-validator: manifest декларирует period/symbols/
  gap-budget (аддитивные поля `snapshot.1` + AJV), CI сверяет декларацию с
  фактическим содержимым bundle.
- Code-default `MOCK_SNAPSHOT_REF` (`src/access/config.ts:33`) увести с
  `2026-06-16-synthetic` (данные 2024 года, bars-only) на SSOT-default.

Auth на `/historical/*` — в карточке
[security-edge-hardening](../../../control-center/docs/delivery/initiatives/security-edge-hardening.md)
(item 10), здесь не дублируется.
