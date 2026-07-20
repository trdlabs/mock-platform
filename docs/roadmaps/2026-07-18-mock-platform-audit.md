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
