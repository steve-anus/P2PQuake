/* qn_maps.c -- mode map pools for the hosting page. Fixed rules, no
 * data table: campaign pool = "start", "lq_end", or
 * "lq_e<digits>m<digits>"; deathmatch pool = the "lqdm" prefix.
 * Case-insensitive ASCII, bounded digit runs, no allocation. */

#include <stddef.h>

#include "qn_maps.h"

#define QN_MAP_PREFIX "lq_e"
#define QN_MAP_DM_PREFIX "lqdm"

static int
qn_tol (int c)
{
	return (c >= 'A' && c <= 'Z') ? c + ('a' - 'A') : c;
}

static int
qn_ieq (const char *s, const char *lit)
{
	while (*s && *lit)
	{
		if (qn_tol ((unsigned char) *s) != (unsigned char) *lit)
			return 0;
		s++;
		lit++;
	}
	return *s == '\0' && *lit == '\0';
}

static int
qn_iprefix (const char *s, const char *lit)
{
	while (*lit)
	{
		if (*s == '\0')
			return 0;
		if (qn_tol ((unsigned char) *s) != (unsigned char) *lit)
			return 0;
		s++;
		lit++;
	}
	return 1;
}

/* one digit run of 1..QN_MAP_DIGITS_MAX chars; returns the position past
 * the run and the value, or NULL for a missing or oversized run. */
static const char *
qn_digits (const char *p, long *out)
{
	long	v = 0;
	int	n = 0;

	while (*p >= '0' && *p <= '9')
	{
		if (n == QN_MAP_DIGITS_MAX)
			return NULL;	/* oversized run */
		v = v * 10 + (*p - '0');
		n++;
		p++;
	}
	if (n == 0)
		return NULL;
	*out = v;
	return p;
}

/* campaign story classification: 1 = start, 2 = lq_e<major>m<minor>,
 * 3 = lq_end, 4 = neither (sorted last, lexicographic tie-break). */
static int
qn_camp_rank (const char *name, long *major, long *minor)
{
	const char *p;

	*major = *minor = 0;
	if (!name)
		return 4;
	if (qn_ieq (name, "start"))
		return 1;
	if (qn_ieq (name, "lq_end"))
		return 3;
	if (!qn_iprefix (name, QN_MAP_PREFIX))
		return 4;
	p = qn_digits (name + (sizeof QN_MAP_PREFIX - 1), major);
	if (!p || qn_tol ((unsigned char) *p) != 'm')
		return 4;
	p = qn_digits (p + 1, minor);
	if (!p || *p != '\0')
		return 4;
	return 2;
}

static int
qn_ilex (const char *a, const char *b)
{
	while (*a && *b)
	{
		int	d = qn_tol ((unsigned char) *a) -
		      qn_tol ((unsigned char) *b);

		if (d)
			return d < 0 ? -1 : 1;
		a++;
		b++;
	}
	if (*a)
		return 1;
	if (*b)
		return -1;
	return 0;
}

int
QN_MapInPool (const char *name, qn_map_pool_t pool)
{
	long	maj, min;

	if (!name || !*name)
		return 0;
	if (pool == QN_POOL_COOP)
		return qn_camp_rank (name, &maj, &min) != 4 ? 1 : 0;
	if (pool == QN_POOL_DM)
		return qn_iprefix (name, QN_MAP_DM_PREFIX);
	return 0;
}

int
QN_MapCompareStory (const char *a, const char *b)
{
	long	am = 0, an = 0, bm = 0, bn = 0;
	int	ra, rb;

	ra = qn_camp_rank (a, &am, &an);
	rb = qn_camp_rank (b, &bm, &bn);
	if (ra != rb)
		return ra < rb ? -1 : 1;
	if (ra == 2)
	{
		if (am != bm)
			return am < bm ? -1 : 1;
		if (an != bn)
			return an < bn ? -1 : 1;
	}
	return qn_ilex (a ? a : "", b ? b : "");
}

/* numeric tail after the lqdm prefix; -1 when the name carries none */
static long
qn_dm_num (const char *name)
{
	const char *p;
	long	v;

	if (!name || !qn_iprefix (name, QN_MAP_DM_PREFIX))
		return -1;
	p = qn_digits (name + (sizeof QN_MAP_DM_PREFIX - 1), &v);
	if (!p || *p != '\0')
		return -1;
	return v;
}

int
QN_PlayersLo (qn_map_pool_t pool)
{
	return (pool == QN_POOL_DM) ? 2 : 1;
}

int
QN_PlayersHi (qn_map_pool_t pool, int hw_limit)
{
	int hi = (pool == QN_POOL_DM) ? QN_PLAYERS_DM_MAX : QN_PLAYERS_COOP_MAX;

	if (hw_limit >= QN_PlayersLo (pool) && hw_limit < hi)
		hi = hw_limit;
	return hi;
}

int
QN_PlayerBounds (qn_map_pool_t pool, int want, int hw_limit)
{
	int lo = QN_PlayersLo (pool);
	int hi = QN_PlayersHi (pool, hw_limit);

	if (want < lo)
		return lo;
	if (want > hi)
		return hi;
	return want;
}

static const char *const qn_skill_text[QN_SKILL_MAX + 1] = {
	"Easy", "Normal", "Hard", "Nightmare"
};

const char *
QN_SkillText (int v)
{
	if (v < 0 || v > QN_SKILL_MAX)
		return NULL;
	return qn_skill_text[v];
}

int
QN_SkillClamp (int v)
{
	if (v < 0)
		return 0;
	if (v > QN_SKILL_MAX)
		return QN_SKILL_MAX;
	return v;
}

int
QN_SkillWrap (int v, int dir)
{
	int	s = QN_SkillClamp (v);

	s += (dir > 0) ? 1 : (dir < 0) ? -1 : 0;
	if (s > QN_SKILL_MAX)
		s = 0;
	else if (s < 0)
		s = QN_SKILL_MAX;
	return s;
}

int
QN_MapCompareDm (const char *a, const char *b)
{
	long	av = qn_dm_num (a);
	long	bv = qn_dm_num (b);

	if (av >= 0 && bv >= 0 && av != bv)
		return av < bv ? -1 : 1;
	if (av >= 0 && bv < 0)
		return -1;
	if (av < 0 && bv >= 0)
		return 1;
	return qn_ilex (a ? a : "", b ? b : "");
}
