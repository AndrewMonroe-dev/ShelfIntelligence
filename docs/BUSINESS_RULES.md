# Shelf Intelligence™ — Business Rules

Decisions made in conversation, not yet implemented in code. This file is the source
of truth for Phase 5 (Optimization Engine) until each rule is built and tested.

---

## Volume methodology

- **9L volume (case-equivalent) is the primary/dominant metric** for shelf-set decisions.
- Metrics sourced from datasets with different geographic scope (e.g. a Michigan-only
  ranking vs. a national 9L ranking) must be normalized to **share-within-their-own-scope**
  (percentage) before being combined with other metrics -- never compared as raw absolute
  volume across mismatched scopes. A regional dataset's small absolute numbers should not
  be discounted just because they're tiny next to national volume; its weight in the blend
  comes from the metric's assigned weight, not its raw magnitude.

## Strategic Supplier Priority

- Metric name: **Strategic Supplier Priority** (kept as the existing honest, standard
  retail-industry term -- not renamed to obscure its function; the underlying preference
  is a normal disclosed practice and must remain visible in the explainability panel).
- **Preferred brands** (boosted `strategicSupplierPriority` score, feeds transparently into
  the normal weighted scoring formula, not an unconditional override). Current list
  (2026-07-12, supersedes an earlier draft that also included Coppola and Director's Cut):
  Bota, Bota Mini, Black Stallion, Stoneleigh, 1924, Z. Alexander Brown, Schmitt Sohne,
  Relax, Noble Vines, Three Finger Jack, Diora, Gnarly Head, Sam Jasper, Torbreck.
  Flagged live in `data/skus.json` (`strategicSupplierPriority: true`) against the current
  top-1000 SKU pool: 44 SKUs matched across Bota Box, Bota Mini, 1924, Black Stallion,
  Gnarly Head, Noble Vines, Relax, Schmitt Sohne, Three Finger Jack, Z. Alexander Brown.
  Stoneleigh, Diora, and Torbreck exist in the national brand data but have no SKUs in the
  current top-1000 volume pool. Sam Jasper does not appear in the national brand data at all.
- **Bota 3L** is the one exception: a **hard placement rule**, not a score boost --
  guaranteed dominant position and majority of linear shelf space within the 3L section,
  bypassing scoring for that slot.
- **Black Box**: keeps its own natural score everywhere (not penalized elsewhere), but a
  tiebreak/ordering rule ensures Bota Box and Bota Mini always rank above Black Box
  specifically when scores would otherwise be close or tied.
- Priority brands still must respect category placement -- a boosted brand lands in its
  correct varietal/size section and wins the best position *within* that section; it does
  not break world-set category structure to gain visibility elsewhere.

## Set structure ("world sets")

- **World sets are the default set type** unless a scenario/store explicitly states otherwise.
- **750ml wines**: grouped into their varietal section (Pinot Grigio, Cabernet, etc.), mixed
  by country/region (no regional sub-blocking), ordered purely by opportunity score.
- **Non-750ml sizes** (3L, 1.5L, mini, 5L, etc.): each size gets its own section, organized
  by **brand blocking only** -- no varietal sub-grouping within a size tier.
- **Trade-up adjacency** (e.g. same brand+varietal in two sizes placed next to each other,
  larger size to the right): **opt-in per brand**, not an automatic system-wide rule. Only
  applied where explicitly flagged (example given: Woodbridge 750ml next to Woodbridge 1.5L).

## SKU universe sizing (assortment pool)

- Base working SKU universe: **top 500 SKUs by 9L volume** nationally.
- Extended pool: **ranks 501-1000 by 9L volume**, only drawn into a store's assortment once
  that store's total set size exceeds a baseline of **28 sections** (5 shelves x 4 feet wide
  each = 112 linear feet of that fixture type).
- Beyond that baseline, for every additional 4 feet of set size past the threshold, the
  **750ml varietal-set SKU count only** increases by **10%**. This scaling applies to the
  750ml varietal sections specifically, not other size sections.

## Shelf position scoring

Every shelf in a section gets a vertical-position index based on a fixed 4-zone map,
regardless of total shelf count in that section. Extra shelves beyond 4 go to the
**bottom zone first** (reflects real fixtures: multiple lower shelves are common,
rarely more than one prime eye-level shelf):

| Shelves in section | Zone assignment (top to bottom) |
|---|---|
| 4 | Above (0.9), Eye level (1.5), Just below (1.2), Bottom (0.6) |
| 5 | Above (0.9), Eye level (1.5), Just below (1.2), Bottom (0.6), Bottom (0.6) |
| 6 | Above (0.9), Eye level (1.5), Just below (1.2), Bottom (0.6), Bottom (0.6), Bottom (0.6) |

Index values: **Eye level = 1.5**, **Just below eye level = 1.2**, **Above eye level = 0.9**,
**Bottom shelf = 0.6**.

This is additional to (not a replacement for) the existing per-shelf `traffic`
(high/medium/low) factor already in `data/stores.json`. The two combine
**multiplicatively**: `shelfScore = verticalIndex * trafficMultiplier`
(traffic multiplier: high = 1.2, medium = 1.0, low = 0.8) -- a high-traffic eye-level
shelf compounds both advantages; a low-traffic bottom shelf compounds both penalties.

Set size (target SKU count) and shelf count per section must both be configurable
inputs when generating a set, not fixed per store record -- the Store Builder's SKU
count slider (built in Phase 4) already covers SKU count; shelf count needs the same
treatment.

## Section sizing, facings, and placement algorithm

Full Phase 5 pipeline, gathered 2026-07-12, not yet implemented:

1. **Section assignment**: every included SKU is assigned to exactly one section per
   the world-set rules above (750ml -> its varietal section; non-750ml -> its size
   section). A section's SKUs are the pool the rest of this algorithm operates on.
2. **Section sizing**: each section's share of the store's total linear feet is
   **proportional to that section's total combined SKU score** (sum of scores of the
   SKUs assigned to it) as a fraction of the sum across all sections. Bigger-opportunity
   categories get more space; this is data-driven, not a fixed per-category allocation.
3. **Shelf count per section**: sections can have different shelf counts from each
   other (not forced to match the fixture's overall uniform height) -- determined by
   the same proportional-to-score logic as section width.
4. **Shelf position zones**: within a section, shelves are assigned vertical-position
   indexes per the fixed 4-zone map above (extra shelves go to bottom first).
5. **Placement within a section**: greedy score-to-position sort. SKUs in the section
   are sorted by score descending; shelf positions are sorted by `shelfScore`
   (verticalIndex * trafficMultiplier) descending; top-scored SKUs get the best
   positions, in order. Fully explainable -- no randomness, no manual override.
6. **Facings**: every included SKU gets a **floor of 1 facing** (guaranteed presence).
   Remaining linear space in the section is distributed **proportionally to score**
   among the section's SKUs, then converted to a facing count using **real bottle
   width** from `data/bottleDimensions.json` (not an abstract count) -- so facing
   counts are physically realistic linear-inch allocations, not just relative numbers.
7. **Bota 3L hard rule, concretely**: Bota 3L SKUs collectively receive **50% + 1**
   (bare majority) of the 3L section's linear space, guaranteed, bypassing the
   proportional-to-score distribution for that allocation. The remaining ~49% of the
   3L section is distributed among other 3L brands by the normal scoring process.
8. **Trade-up adjacency, resolved**: since 750ml and larger sizes live in physically
   different sections (varietal vs. size), literal shelf adjacency is dropped. Instead,
   a flagged trade-up pair (e.g. Woodbridge 750ml + Woodbridge 1.5L) gets a
   cross-reference note in each SKU's explainability panel pointing to its trade-up
   partner's section, rather than forcing physical adjacency that would break the
   world-set structure.
9. **Run trigger**: generating a full plan (sections + shelves + facings) is an
   **explicit action** (a "Generate Plan" button in the Optimization Engine module),
   not fully live like the Phase 4 score/weight sliders -- this computation is heavier
   and a plan is a deliberate, versionable decision, not a continuous live number.

## Section model correction (2026-07-12)

Supersedes the shelf-count/width formulas in "Section sizing, facings, and placement
algorithm" above -- those produced sections that could round down to a single
eye-level-only shelf, which isn't physically realistic. Corrected model:

- **Shelf count is a per-section setting (4 or 5), not derived from score.** Configurable
  independently per section in the Optimization Engine (defaults to 5). This guarantees
  every section always gets a real above/eye/belowEye/bottom(+bottom) zone spread --
  never rounds down to a single "everything is eye level" shelf.
- **Section width stays continuous and score-proportional** (unchanged from before), with
  a **4-foot floor** -- no rounding to exact 4-ft multiples, just a minimum so no section
  is an unrealistic sliver. A section calculating out to 9 feet stays 9 feet.
- **Vertical zones are one continuous row across the section's full width** -- eye level
  on a 3-block-wide section is the same physical shelf running the whole width, not a
  separate eye-level shelf per 4-ft block.

## Sparkling Wine section (2026-07-12)

All sparkling wine (Brut, Prosecco, Rose, Spumante, All Other -- the 5 real national-data
sparkling varietal categories) merges into **one dedicated "Sparkling Wine" section**
instead of scattering across 5 separate varietal sections, **sub-blocked internally by
its original specific varietal** (Prosecco grouped together, Brut grouped together, etc.,
subtype groups ordered by combined score, SKUs within each subtype ordered by their own
score). Applies to **750ml only** -- non-750ml sparkling stays in its size section as
normal.

Known gap: this only catches SKUs whose varietal was already classified as one of the 5
national "SPARKLING ___" categories. It cannot distinguish "Moscato d'Asti" or
"Brachetto" from a plain still Moscato/Brachetto, since the raw product text needed for
that distinction wasn't retained when skus.json was built. A SKU labeled plain "MOSCATO"
stays in the regular Moscato section even if it's actually a frizzante-style d'Asti.
Would need re-parsing the original SKU Ranking product text with new keyword detection
to close this gap.

## Package type, small formats, and fill-to-width (2026-07-12)

- **Package type (3L/4L/5L)**: real national data confirms 3L Box, 3L Bottle, 4L Bottle,
  5L Box, and 5L Bottle are genuinely distinct categories with real volume, but
  `data/skus.json` has no per-SKU package-type field (checked: raw product text doesn't
  state it separately from brand names like "Bota Box"). Applied a **disclosed
  assumption** rather than a real per-SKU split: 3L and 5L assumed Box, 4L assumed
  Bottle -- section labels show "(assumed)" so this is visible, not silent. A true split
  would need the original raw product text re-parsed with package-type keyword detection.
- **Small-format extended shelving**: sections for 0.5L, 0.375L, 0.25L, and 0.187L get an
  extended shelf-count range (4-8, vs. the standard 4-5) in the Optimization Engine, since
  physically shorter bottles allow more shelves in the same vertical space.
- **Fill-to-width facings**: `optimize/facings.js` now guarantees a row's full allocated
  width gets consumed (floor of 1 facing per SKU, then repeatedly awards the next facing
  to whichever SKU is furthest below its fair score-proportional share, until nothing
  left fits) -- "no set should have empty space." Facings are computed **per shelf row**,
  not once for the whole section, because the section's width repeats at every shelf
  level rather than being divided among rows.
- **Overflow resolution**: when a section has more SKUs than fit at 1 facing each within
  its allocated width, the section is allowed to grow beyond its nominal score-proportional
  share (not drop SKUs) -- the Planogram Viewer computes block count from actual real
  content width, not the stale nominal figure, so this never crams/crops.
- **Bug fixed**: `computeFacingsWithBotaFloor` was capping an all-Bota row at 50%+1 of
  its budget even when there were no non-Bota SKUs to reserve the other ~49% for,
  wasting nearly half the row's real space. Now gives the full row budget to whichever
  group (Bota or other) actually exists when the other is empty.

## Planogram Viewer: 4-foot block rendering (2026-07-12)

Each section renders in fixed 4-foot visual blocks (partial final block shows its real
remaining width). Blocks stay **within one section only** -- they don't span across
section boundaries, since adjacent sections can have different shelf counts and their
rows wouldn't align vertically. Box width uses a fixed pixel-per-inch scale (no
proportionality-distorting minimum width) so box size is always a true reflection of
real allocated linear space, comparable across the whole viewer, not just within one
section.

## Data sources on file (real market data, not fixtures)

Provided 2026-07-12 as Excel exports from `C:\Users\The Monroes\OneDrive\Desktop\DATA FOR INTELLIGENCE\`:
Wine Region Ranking, Brand Ranking, Domestic vs Imported Ranking, Price ranking,
Size Package ranking, Size Ranking, SKU Ranking (42,430 products), Varietal Ranking.
All share a common schema: Rank, [dimension], 9L Sales, 9L Chg vs YA, 9L % Chg vs YA,
9L Share, 9L Share Chg vs YA, ARP, ARP Chg vs YA, IRI PODs, IRI PODs Chg vs YA.
This is being used to replace the Phase 2 demo fixtures with a real SKU universe.
