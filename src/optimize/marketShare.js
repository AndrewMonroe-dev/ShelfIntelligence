// Market-share-based section sizing, per 2026-07-12 clarification: for 3L,
// 4L, 5L, and anything under 747ml, varietal composition is irrelevant --
// these sections are self-contained, ranked against the OTHER categories
// (Cabernet, Sauvignon Blanc, etc.) and sized according to their real
// national market share, not the sum of their assigned SKUs' opportunity
// scores (which is how every other -- varietal -- section is sized).

import { PACKAGE_TYPE_ASSUMPTIONS } from './blocking.js';

const MARKET_SHARE_EXEMPT_SIZES = new Set(['3LT', '4LT', '5LT', '0.5LT', '0.375LT', '0.25LT', '0.187LT']);

export function isMarketShareSection(section) {
  if (section.type !== 'size') return false;
  const size = section.key.replace('size:', '');
  return MARKET_SHARE_EXEMPT_SIZES.has(size);
}

// Maps a section's size key ("3LT") to the matching real national
// Size Package Ranking label ("3L BOX"), using the same assumed package
// type already applied to that section's label.
function nationalSizePackageLabel(size) {
  const numPart = size.replace('LT', '');
  const pkg = PACKAGE_TYPE_ASSUMPTIONS[size];
  if (!pkg) return null;
  return `${numPart}L ${pkg.toUpperCase()}`;
}

// Returns the section's real national 9L share (a fraction of all US wine
// volume, e.g. 0.102 for a category that's 10.2% of the market), or 0 if no
// matching row exists in the data.
export function getSectionMarketShare(section, sizePackageData) {
  const size = section.key.replace('size:', '');
  const label = nationalSizePackageLabel(size);
  if (!label || !sizePackageData) return 0;
  const row = sizePackageData.find((r) => r.label === label);
  return row ? row.share9L : 0;
}
