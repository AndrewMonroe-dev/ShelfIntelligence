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
- **2026-07-23 addition: Francis Coppola Diamond Collection** (all sub-lines -- Diamond
  Collection, Diamond Collection Black Label, Diamond Collection Paso Robles -- every size,
  20 SKUs) added to Strategic Supplier Priority, reversing the 07-12 exclusion above per
  Andrew's explicit instruction. Also flagged `alwaysInclude: true` (stronger than every
  other brand on this list, which only get a score boost) -- Coppola Diamond SKUs place in
  their set regardless of score, not just win ties. Implemented via
  `data/curationRules.json`'s `supplierFavoredBrands` rule (brand-substring match, so future
  new Coppola Diamond sizes/flavors are covered automatically without a code change).
- **2026-07-23 addition: plain Francis Coppola (non-Diamond) Cabernet Sauvignon 0.75LT**
  (skuId 001200, UPC 0739958079301) added to Strategic Supplier Priority -- scoring/anchor
  boost only, deliberately NOT alwaysInclude, per Andrew's explicit instruction. The other
  two plain Francis Coppola SKUs (003334 Cabernet Sauvignon, 004063 Chardonnay) were
  explicitly excluded -- do not add them without a new instruction. Implemented via
  `data/curationRules.json`'s `supplierFavoredUpcs` rule (UPC-scoped, not brand-wide, since
  this is one SKU out of three sharing the same brand).
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
| 4 | Eye level (1.5), Just below (1.2), Below waist (0.8), Bottom (0.6) |
| 5 | Above (0.9), Eye level (1.5), Just below (1.2), Bottom (0.6), Bottom (0.6) |
| 6 | Above (0.9), Eye level (1.5), Just below (1.2), Bottom (0.6), Bottom (0.6), Bottom (0.6) |

A 4-shelf bay has no shelf above eye level -- the top shelf itself IS the
best-selling/eye-level position, so "Above" only applies once a 5th shelf
exists above it.

Index values: **Eye level = 1.5**, **Just below eye level = 1.2**, **Above eye level = 0.9**,
**Below waist = 0.8**, **Bottom shelf = 0.6**.

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

## Price-point shelf position rules (2026-07-12)

Applies to **750ml varietal sections only** (Cabernet, Sparkling Wine, etc.) -- size
sections (3L, 5L, 4L, and anything under 750ml) are exempt entirely. Mostly HARD
constraints (position-number-based, counted from top=1 to bottom=shelfCount):

- **Under $10**: no higher than the second shelf from the bottom (confined to the bottom
  2 physical positions).
- **$10-$14**: cannot be top shelf (allowed everywhere except position 1).
- **$14-$20**: no lower than second from the bottom (allowed everywhere except the very
  bottom position).
- **$20+**: no hard restriction.

Soft preferences layered on top (implemented as a scoring multiplier, not a hard
exclusion): **eye level mainly goes to $10-14/$14-20** ("TOP SKUs" for those bands);
**top shelf mostly goes to $20+**. If a section has no SKU in a given band, its reserved
positions backfill with the next-closest band rather than sitting empty.

**No automated "large brand" override** -- no concrete threshold was defined ("leave it
open for crazy outliers, prompt when found"). Instead, `optimize/priceBand.js` flags in
a SKU's explainability reasons when its natural best-scoring position was excluded by
its price band, for manual review rather than a guessed auto-override rule.

Implemented in `optimize/priceBand.js` + `optimize/placementSolver.js`'s
`partitionIntoShelvesConstrained`.

## Market-share-based section sizing for size categories (2026-07-12)

For 3L, 4L, 5L, and anything under 747ml: varietal composition is irrelevant (no
sub-blocking by varietal, unchanged). These sections are sized by their **real national
market share** (from `data/market/size_package.json`, using the same assumed package
type already applied to their labels) instead of the sum of their assigned SKUs'
opportunity scores -- "ranked against other categories... given space according to
their category share within the overall market." The real share is scaled against the
same grand-total score used everywhere else so it competes for space on comparable
footing with score-sized varietal sections. Implemented in `optimize/marketShare.js`.

## Case Only Mode (2026-07-12)

Global toggle (Optimization Engine, alterable before generating a plan): when off
(default), 750ml SKUs get a facing floor of 1. When on, the floor becomes 2. Applies to
750ml varietal sections only -- size sections are unaffected.

## Store quality and the "+ Add Store" flow (2026-07-12)

Store Builder has an "+ Add Store" card: name, horizontal size of set (linear feet),
average number of shelves, and a quality slider (-1 budget .. 0 neutral .. +1 high-end).
A brand-new store has no real per-shelf traffic data, so a default shelf layout is
synthesized from the average count (mostly medium traffic, middle shelf marked high).

The quality slider biases the existing **Price Point Strength** metric for that store's
plan specifically (not a parallel scoring system): its raw value is multiplied by a
bounded, symmetric factor based on how well a SKU's price aligns with the store's
quality tier (premium threshold: $15). High-end stores get a real scoring boost for
$15+ SKUs; budget stores get the boost for sub-$15 SKUs; qualityScore 0/unset (all
original fixture stores) means no change from prior behavior. Implemented in
`calc/metricRegistry.js`'s `qualityAlignmentMultiplier`, threaded through
`scoreEngine.js`/`assortment.js`/`placementSolver.js` as an optional `context` param.

New stores persist to localStorage (`customStores`) and survive a reload, same as every
other user override.

## Regional section (2026-07-15)

Resolves the "what data field defines regional" block flagged 2026-07-13. **Regional is
domestic/local, not the existing `region` field** (which is country-of-origin and stays
as-is for everything else -- France, Italy, Argentina, etc.). A SKU is Regional if its raw
product-name text contains **Michigan or Indiana** -- the two in-market domestic
production sources identified in the Michigan-specific dataset (`MI Specific Data.xlsx`).
Michigan and Indiana hits merge into one combined **Regional** category rather than staying
two separate sections, same pattern as the existing Sparkling merge (Prosecco/Asti/Cava/etc.
-> one section). Applied in the offline categorization pass (`run_categorize.js`): 173 SKUs
(158 Michigan + 15 Indiana, all above the $1,000 sales floor) landed in Regional out of the
4,117-SKU categorized set. Not yet wired into `data/skus.json` or the live placement
algorithm -- still pending the brand-parsing and skus.json rebuild work.

## 3L assortment exclusions (glass, not box)

Some brands' "3L" catalog entries are glass bottles, not the 3L box format the 3L
section assumes (see `PACKAGE_TYPE_ASSUMPTIONS` in `blocking.js`) -- excluded from the
assortment entirely via `isExcludedSku`, not just deprioritized:

- **Carlo Rossi 3L** (Andrew, 2026-07-15): doesn't come in a 3L box, not endemic to
  Michigan.
- **Riunite 3L** (Andrew, 2026-07-16): glass, not a box.

## Data quirk: "0.748LT" is actually a 4-pack of 187ml (2026-07-16)

16 SKUs (Sutter Home x8, Cook's, Woodbridge x2, Barefoot Bubbly, Sutter Home Sweet Red,
Korbel, Cavit, Barefoot Pinot Grigio, Woodbridge Cabernet) carried raw size `0.748LT` --
the summed volume of a 4-pack of 187ml splits, not a real size code. Andrew confirmed
these are 4-packs. Relabeled to `0.187LT X4` in `data/skus.json` so they form their own
"4-Pack" section (`CONFIRMED_PACKAGE_TYPES` in `blocking.js`) instead of scattering into
either the 750ml varietal sections or the true single-mini `0.187LT` section (La Marca,
Sutter Home Pinot Grigio/Chardonnay minis, which are real singles and stay separate).
(Its bottle-width entry was an estimate at the time; superseded by the authoritative
measurement table below, same day.)

## Bottle/box widths now sourced from Andrew's measurement table (2026-07-16)

`data/bottleDimensions.json` and `facings.js`'s width lookup were rebuilt from scratch
from `D:\Jarvis\Suggested Measurements of wine sizes.xlsx` -- Andrew's own corrected
measurements, not derived or estimated. This replaces every prior width figure in the
file, including ones that predate this session (750ml, 1.5L, 3L, 5L, etc. all changed,
some significantly -- e.g. 3L box width was 7.4in, corrected to 4.75in; 1.5L was 4.5in,
corrected to 4.0in). Context: a shelf was visibly overcrowded (many more SKUs rendering
than 48in of physical shelf could hold) because several size codes -- `0.5LT` (39 SKUs),
`4LT` (8 SKUs, all Carlo Rossi jugs), and every multi-pack size except `0.187LT X4` --
had no real dimension entry and were silently defaulting to a flat 3.0in fallback
regardless of true footprint. Two rounds of self-corrected estimates for those gaps
turned out to still be assumptions Andrew hadn't validated, so the fix is now sourced
directly from his own measurement research instead.

`bottleDimensions.json` entries are now keyed by the exact `bottleSizeRaw` string
(`"0.75LT"`, `"0.187LT X4"`, etc.) -- `facings.js`'s `bottleWidthInches()` looks up that
key directly, no more per-size mapping table or derived multi-pack formula. A size with
no entry at all (only the single-SKU `0.72LT`, which does have its own entry) falls back
to 3.1in (the measured 0.75LT width).

Two package types the table explicitly flags as not belonging in a set at all --
`0.187LT X5` ("These do not belong in sets. Period.") and `0.187LT X24`, the 24-bottle
advent-calendar carton ("DOES NOT BELONG IN SET") -- are now excluded via `isExcludedSku`
in `blocking.js`, same mechanism as the Carlo Rossi/Riunite 3L exclusions.

## Seasonal assortment exclusions (2026-07-16)

Menage a Trois Assorted (UPC 0196383007961, was its own `2.25LT` size section) and Stella
Rosa Assorted (UPC 0087872635091, was its own `0.935LT` size section) are seasonal
assortment packs -- Andrew ruled both out for future use. Excluded via `isExcludedSku` by
exact UPC (not brand regex) since both brand families have many other legitimate
single-varietal SKUs that must stay in the assortment.

## Live data source replaced with Michigan-specific sales (2026-07-16)

`data/skus.json` was rebuilt from `MI Specific Data.xlsx` (Michigan-only $ Sales/ARP/IRI
PODs/YoY-change, 8,271 raw products) and now **replaces** the national top-1000 file as
the app's entire SKU universe -- the national file reflected national top sellers, not
what actually sells in Michigan, per Andrew's direction. Build pipeline (not yet a
committed repo script -- ran from a scratchpad, needs to be relocated into the repo next
session per the standing open item on `run_categorize.js`/`parse_brands.js`):

1. Parse each row's blended `Product` string (format `NAME N CT SIZE LT - UPC`, a few
   reordered variants handled) into name, pack count (CT), per-pack size, and UPC.
2. Drop every row under $1,000 in sales (Andrew's standing floor, confirmed 2026-07-16),
   plus the full standing seasonal/multi-pack exclusion list (`mi_seasonal_pack_deletes.csv`
   -- Menage a Trois Assorted, Stella Rosa Assorted, Bev Glam Rose, Holiday Cheer/12 Days
   Advent Calendars, Opera Prima Mimosa, Silk & Spice Assorted, Sutter Home WZ 2CT/3LT,
   Bubly Wine Refresher Assorted, Sofia Mini Blanc de Blancs, both Spritz Society flavors,
   all 11 Barefoot Spritzer SKUs).
3. Brand: matched against the national `data/skus.json`'s already-corrected brand
   vocabulary (longest-prefix match) after stripping a trailing region/state/country
   word from the raw name. Falls back to a 2-word guess when no vocab match -- not
   re-verified against raw source the way the national 07-15 rebuild was, so brand
   fidelity here is lower confidence than the national file's.
4. Region/category (750ml only): Michigan/Indiana keyword -> `varietal: "REGIONAL"`;
   foreign-country keyword (no US state) with no grape-varietal match -> `varietal` set
   to the country name (e.g. `"ITALY"`), same generic section mechanism as a real
   varietal; flavored/sweet keyword (spritzer, sangria, bellini, mimosa, cooler,
   fruit-flavor words) -> `"FLAVORED/SWEET"`; else keyword-matched against the standard
   grape-varietal list (Claret folds into Cabernet; Prosecco/Asti/Cava/Brut/
   Frizzante/Champagne/Spumante fold into Sparkling; bare "RED" folds into Red Blend);
   else the Andrew-approved manual fills from `mi_no_varietal.csv` by UPC; else left
   unassigned (lands in the existing "Unspecified Varietal" catch-all section, ~3.5% of
   750ml SKUs vs. ~24% in the old national file).
5. Multi-packs (CT > 1, mostly 187ml mini 4-packs) get their own size section keyed
   `{size}LT X{count}` (e.g. `"0.187LT X4"`) instead of being folded into either the
   750ml varietal sections or the true single-mini size section -- same fix as the
   `0.748LT` bug from earlier in this session, just applied dataset-wide instead of as
   a one-off patch.
6. Ranked by $ Sales descending. Top 750 = `assortmentTier: "base"`, next 1,000 (ranks
   751-1750) = `"extended"`, everything beyond rank 1,750 dropped entirely (Andrew,
   2026-07-16) -- so the live SKU universe is 1,750 total, not 1,000.
7. Scoring fields recomputed from the MI file's own numbers, not carried over from the
   national cross-reference exports: `sales9L`/`share9L` now hold **dollar** sales/share
   (not 9L volume -- consistent with the metric switch approved 2026-07-14),
   `brandSales9L`/`varietalSales9L`/`regionSales9L`/`sizeSales9L` and their `*Share9L`
   pairs summed within the final 1,750-SKU pool, `podsDistribution` from the MI file's
   `IRI PODs` column directly, `growthPct9L` from its `$ % Chg vs YA` column directly
   (the MI file has real YoY data, unlike originally assumed 2026-07-14).
   `priceSegmentShare9L` uses a new, cleaner non-overlapping ARP band scheme (Value
   $0-4.49 / Popular $4.50-7.99 / Premium $8-10.99 / Super Premium $11-14.99 / Ultra
   Premium $15+) rather than reusing the national file's box/bottle-conflated labels.
8. `strategicSupplierPriority` carried over by brand-prefix match against the same
   supplier list flagged `true` in the old national file (Bota Box/Mini, Gnarly Head,
   Noble Vines, Relax, Schmitt Sohne, Three Finger Jack, Z Alexander Brown, Black
   Stallion, 1924) -- this was a manual designation, not derived from sales data, so it
   just transfers as-is.
9. `image`/`skuId`: where a MI SKU's UPC exactly matches a national-file SKU (849 of
   1,750), its existing `skuId` and image path carry over unchanged. The remaining 901
   MI-only SKUs get new sequential IDs (`001001`+) and a null `image` (the app doesn't
   currently render per-SKU images anywhere in the UI -- Planogram Viewer uses text
   spine labels -- so this has no visible effect today, but would need real images if
   that ever changes).

Backups: pre-replacement national file at
`D:\Jarvis\skus_backup_2026-07-16_pre-MI-replacement_NATIONAL.json`.

## Data sources on file (real market data, not fixtures)

Provided 2026-07-12 as Excel exports from `C:\Users\The Monroes\OneDrive\Desktop\DATA FOR INTELLIGENCE\`:
Wine Region Ranking, Brand Ranking, Domestic vs Imported Ranking, Price ranking,
Size Package ranking, Size Ranking, SKU Ranking (42,430 products), Varietal Ranking.
All share a common schema: Rank, [dimension], 9L Sales, 9L Chg vs YA, 9L % Chg vs YA,
9L Share, 9L Share Chg vs YA, ARP, ARP Chg vs YA, IRI PODs, IRI PODs Chg vs YA.
This is being used to replace the Phase 2 demo fixtures with a real SKU universe.
