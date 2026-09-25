/* qn_maps.h -- mode map pools for the hosting page (co-op campaign maps,
 * deathmatch lqdm maps). Pure (no engine symbols) so the unit battery
 * pins the shipped bytes the engine also dispatches through. */
#ifndef QN_MAPS_H
#define QN_MAPS_H

typedef enum { QN_POOL_COOP = 0, QN_POOL_DM = 1 } qn_map_pool_t;

#define QN_MAP_DIGITS_MAX 8	/* bounded digit runs: longer is garbage */

/* 1 iff `name` belongs to `pool`, else 0. Case-insensitive, bounded
 * scan, no allocation. COOP pool: exactly "start", exactly "lq_end",
 * or "lq_e<digits>m<digits>" (runs of 1..QN_MAP_DIGITS_MAX digits).
 * DM pool: the "lqdm" prefix. */
int QN_MapInPool (const char *name, qn_map_pool_t pool);

/* Deterministic total orderings for qsort over NUL-terminated names.
 * Story: start, then lq_e<major>m<minor> numerically, then lq_end;
 * names outside the campaign pattern sort last, case-insensitive
 * lexicographic. DM: numeric lqdm digits first (lqdm2 before lqdm10),
 * same lexicographic fallback. Both antisymmetric and consistent. */
int QN_MapCompareStory (const char *a, const char *b);
int QN_MapCompareDm (const char *a, const char *b);

#endif	/* QN_MAPS_H */
