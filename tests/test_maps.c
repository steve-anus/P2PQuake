/* test_maps.c -- pins the mode map pools (co-op campaign, deathmatch
 * lqdm) and the story/dm orderings: every shipped name to its pool
 * (positive and negative), hostile/oversized names, digit edge cases,
 * case folding, and qsort integration. Links the shipped module
 * (src/driver/qn_maps.c arrives through the Makefile driver wildcard,
 * so the bytes pinned here are the bytes the engine dispatches). */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../src/driver/qn_maps.h"

static int checks;
static int failures;

#define CHECK(cond)                                                     \
    do {                                                                \
        checks++;                                                       \
        if (!(cond)) {                                                  \
            failures++;                                                 \
            printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #cond);      \
        }                                                               \
    } while (0)

/* the shipped campaign inventory (pak0/pak1 + gamedata enumeration) */
static const char *const campaign[] = {
    "start",
    "lq_e0m1", "lq_e0m2", "lq_e0m3", "lq_e0m4",
    "lq_e0m5", "lq_e0m6", "lq_e0m7", "lq_e0m8",
    "lq_e1m1", "lq_e1m2", "lq_e1m3", "lq_e1m4",
    "lq_e1m5", "lq_e1m6", "lq_e1m7", "lq_e1m8",
    "lq_e2m1", "lq_e2m2", "lq_e2m3", "lq_e2m4",
    "lq_e2m5", "lq_e2m6", "lq_e2m7",
    "lq_e3m1", "lq_e3m2", "lq_e3m3", "lq_e3m4",
    "lq_e3m5", "lq_e3m6", "lq_e3m7",
    "lq_e4m1", "lq_e4m2", "lq_e4m3", "lq_e4m4",
    "lq_e4m5", "lq_e4m6", "lq_e4m7", "lq_e4m8",
    "lq_end"
};
#define CAMPAIGN_N ((int)(sizeof(campaign) / sizeof(campaign[0])))

static const char *const dmaps[] = {
    "lqdm1", "lqdm2", "lqdm3", "lqdm4", "lqdm5", "lqdm6", "lqdm7",
    "lqdm8", "lqdm9", "lqdm10", "lqdm11", "lqdm12", "lqdm13"
};
#define DMAPS_N ((int)(sizeof(dmaps) / sizeof(dmaps[0])))

static void test_pool(void)
{
    char big[128];
    int i;

    for (i = 0; i < CAMPAIGN_N; i++)
        CHECK(QN_MapInPool(campaign[i], QN_POOL_COOP) == 1);
    for (i = 0; i < DMAPS_N; i++)
        CHECK(QN_MapInPool(dmaps[i], QN_POOL_DM) == 1);

    /* case folding across the classes */
    CHECK(QN_MapInPool("START", QN_POOL_COOP) == 1);
    CHECK(QN_MapInPool("Lq_End", QN_POOL_COOP) == 1);
    CHECK(QN_MapInPool("LQ_E2M7", QN_POOL_COOP) == 1);
    CHECK(QN_MapInPool("LqDm11", QN_POOL_DM) == 1);

    /* the DM rule is prefix-only: any name under lqdm */
    CHECK(QN_MapInPool("lqdm", QN_POOL_DM) == 1);
    CHECK(QN_MapInPool("lqdmX", QN_POOL_DM) == 1);

    /* cross-pool: neither map class plays the other mode */
    for (i = 0; i < CAMPAIGN_N; i++)
        CHECK(QN_MapInPool(campaign[i], QN_POOL_DM) == 0);
    for (i = 0; i < DMAPS_N; i++)
        CHECK(QN_MapInPool(dmaps[i], QN_POOL_COOP) == 0);

    /* excluded inventory: fits neither pool */
    {
        static const char *const neither[] = {
            "dev", "e1m8", "e1m1", "b_droved", "b_jeep_chase",
            "start1", "star", "lq_end1", "lq_e", "lq_e1m", "lq_em1",
            "lq_e1xm1", "lq_e11", "lq_e1m1x", "lq_e1m1 ", "lqxe1m1",
            "lqd", "qdm1"
        };
        int j;
        for (j = 0; j < (int)(sizeof(neither)/sizeof(neither[0])); j++) {
            CHECK(QN_MapInPool(neither[j], QN_POOL_COOP) == 0);
            CHECK(QN_MapInPool(neither[j], QN_POOL_DM) == 0);
        }
    }
    CHECK(QN_MapInPool("lqdm1x", QN_POOL_COOP) == 0);

    /* digit edge cases: zero and multi-digit runs in, garbage out */
    CHECK(QN_MapInPool("lq_e0m1", QN_POOL_COOP) == 1);
    CHECK(QN_MapInPool("lq_e10m10", QN_POOL_COOP) == 1);
    CHECK(QN_MapInPool("lq_e12345678m12345678", QN_POOL_COOP) == 1);
    CHECK(QN_MapInPool("lq_e123456789m1", QN_POOL_COOP) == 0);
    CHECK(QN_MapInPool("lq_e1m123456789", QN_POOL_COOP) == 0);

    /* degenerate inputs */
    CHECK(QN_MapInPool("", QN_POOL_COOP) == 0);
    CHECK(QN_MapInPool("", QN_POOL_DM) == 0);
    CHECK(QN_MapInPool(NULL, QN_POOL_COOP) == 0);
    CHECK(QN_MapInPool(NULL, QN_POOL_DM) == 0);
    memset(big, 'a', sizeof(big) - 1);
    big[sizeof(big) - 1] = '\0';
    CHECK(QN_MapInPool(big, QN_POOL_COOP) == 0);
    CHECK(QN_MapInPool(big, QN_POOL_DM) == 0);
    memcpy(big, "lqdm", 4);
    memset(big + 4, '9', 100);
    CHECK(QN_MapInPool(big, QN_POOL_DM) == 1);   /* prefix rule: in */
    memcpy(big, "lq_e", 4);
    memset(big + 4, '9', 100);
    big[sizeof(big) - 1] = '\0';
    CHECK(QN_MapInPool(big, QN_POOL_COOP) == 0); /* run past the cap */
}

static int sgn(int v)
{
    return v < 0 ? -1 : (v > 0 ? 1 : 0);
}

static int cmp_story_v(const void *a, const void *b)
{
    return QN_MapCompareStory((const char *)a, (const char *)b);
}

static int cmp_dm_v(const void *a, const void *b)
{
    return QN_MapCompareDm((const char *)a, (const char *)b);
}

static void test_bounds(void)
{
    /* co-op fills 1..4 including the host; deathmatch 2..16 */
    CHECK(QN_PlayersLo(QN_POOL_COOP) == 1);
    CHECK(QN_PlayersLo(QN_POOL_DM) == 2);
    CHECK(QN_PlayersHi(QN_POOL_COOP, 64) == 4);
    CHECK(QN_PlayersHi(QN_POOL_DM, 64) == 16);
    /* an engine limit clamps down inside the mode's band */
    CHECK(QN_PlayersHi(QN_POOL_COOP, 3) == 3);
    CHECK(QN_PlayersHi(QN_POOL_DM, 9) == 9);
    /* a below-minimum limit never lowers the mode's floor */
    CHECK(QN_PlayersHi(QN_POOL_DM, 1) == 16);
    CHECK(QN_PlayersHi(QN_POOL_DM, 0) == 16);
    CHECK(QN_PlayersHi(QN_POOL_DM, -5) == 16);
    CHECK(QN_PlayersHi(QN_POOL_COOP, 0) == 4);
    CHECK(QN_PlayerBounds(QN_POOL_COOP, 0, 64) == 1);
    CHECK(QN_PlayerBounds(QN_POOL_COOP, -999, 64) == 1);
    CHECK(QN_PlayerBounds(QN_POOL_COOP, 5, 64) == 4);
    CHECK(QN_PlayerBounds(QN_POOL_COOP, 2, 64) == 2);
    CHECK(QN_PlayerBounds(QN_POOL_DM, 1, 64) == 2);
    CHECK(QN_PlayerBounds(QN_POOL_DM, 17, 64) == 16);
    CHECK(QN_PlayerBounds(QN_POOL_DM, 16, 64) == 16);
    CHECK(QN_PlayerBounds(QN_POOL_DM, 100, 9) == 9);
    CHECK(QN_PlayerBounds(QN_POOL_DM, 1, 1) == 2);
    CHECK(QN_PlayerBounds(QN_POOL_COOP, 7, 3) == 3);
    CHECK(QN_PlayerBounds(QN_POOL_COOP, 9, 0) == 4);
}

static void test_order(void)
{
    char list[64][16];
    int i, j;

    CHECK(QN_MapCompareStory("start", "lq_e0m1") < 0);
    CHECK(QN_MapCompareStory("lq_e0m8", "lq_e1m1") < 0);
    CHECK(QN_MapCompareStory("lq_e1m1", "lq_e1m2") < 0);
    CHECK(QN_MapCompareStory("lq_e1m8", "lq_e2m1") < 0);
    CHECK(QN_MapCompareStory("lq_e4m7", "lq_e4m8") < 0);
    CHECK(QN_MapCompareStory("lq_e4m8", "lq_end") < 0);
    CHECK(QN_MapCompareStory("dev", "lq_end") > 0);      /* neither sorts last */
    CHECK(QN_MapCompareStory("dev", "abc") > 0);          /* lex within rank 4 */
    CHECK(QN_MapCompareStory("START", "start") == 0);     /* folded equals */
    CHECK(QN_MapCompareStory("LQ_E1M2", "lq_e1m2") == 0);

    /* antisymmetry over a mixed sample */
    {
        static const char *const sample[] = {
            "start", "lq_end", "lq_e1m2", "lq_e10m1", "dev", "",
            "Lq_E0m8", "lq_e0m8", "lqdm3"
        };
        int n = (int)(sizeof(sample)/sizeof(sample[0]));
        for (i = 0; i < n; i++)
            for (j = 0; j < n; j++)
                CHECK(sgn(QN_MapCompareStory(sample[i], sample[j])) ==
                      -sgn(QN_MapCompareStory(sample[j], sample[i])));
    }

    /* qsort integration: a scrambled campaign list returns in story order */
    for (i = 0; i < CAMPAIGN_N; i++) {
        int k = (i * 7 + 3) % CAMPAIGN_N;   /* deterministic scramble */
        snprintf(list[i], sizeof(list[i]), "%s", campaign[k]);
    }
    qsort(list, (size_t)CAMPAIGN_N, sizeof(list[0]), cmp_story_v);
    for (i = 0; i < CAMPAIGN_N; i++) {
        CHECK(strcmp(list[i], campaign[i]) == 0);
        CHECK(QN_MapCompareStory(list[i], campaign[i]) == 0);
        if (QN_MapCompareStory(list[i], campaign[i]) != 0)
            printf("  story[%d]=%s want %s\n", i, list[i], campaign[i]);
    }

    /* DM: numeric ordering, not lexicographic (lqdm10 after lqdm9) */
    CHECK(QN_MapCompareDm("lqdm2", "lqdm10") < 0);
    CHECK(QN_MapCompareDm("lqdm10", "lqdm9") > 0);
    CHECK(QN_MapCompareDm("LQDM1", "lqdm1") == 0);
    CHECK(QN_MapCompareDm("lqdmX", "lqdm1") > 0);         /* numeric first */
    for (i = 0; i < DMAPS_N; i++) {
        int k = (i * 5 + 2) % DMAPS_N;
        snprintf(list[i], sizeof(list[i]), "%s", dmaps[k]);
    }
    qsort(list, (size_t)DMAPS_N, sizeof(list[0]), cmp_dm_v);
    for (i = 0; i < DMAPS_N; i++) {
        CHECK(strcmp(list[i], dmaps[i]) == 0);
        CHECK(QN_MapCompareDm(list[i], dmaps[i]) == 0);
        if (QN_MapCompareDm(list[i], dmaps[i]) != 0)
            printf("  dm[%d]=%s want %s\n", i, list[i], dmaps[i]);
    }
    for (i = 0; i < DMAPS_N; i++)
        for (j = 0; j < DMAPS_N; j++)
            CHECK(sgn(QN_MapCompareDm(dmaps[i], dmaps[j])) ==
                  -sgn(QN_MapCompareDm(dmaps[j], dmaps[i])));

    {
        static const char *const dmsample[] = {
            "lqdm1", "lqdm10", "lqdmX", "lqdm", "lqdm0", "lqdm01",
            "lqdm123456789", "lqdm_1", "LQDM7", "junk"
        };
        int dn = (int)(sizeof(dmsample)/sizeof(dmsample[0]));
        for (i = 0; i < dn; i++)
            for (j = 0; j < dn; j++)
                CHECK(sgn(QN_MapCompareDm(dmsample[i], dmsample[j])) ==
                      -sgn(QN_MapCompareDm(dmsample[j], dmsample[i])));
        {
            static const char *const s2[] = {
                "start", "lq_e0m8", "lq_e1m1", "lq_end", "dev", "abc"
            };
            int m = (int)(sizeof(s2)/sizeof(s2[0]));
            int a, b, c;
            for (a = 0; a < m; a++)
                for (b = 0; b < m; b++)
                    for (c = 0; c < m; c++) {
                        if (QN_MapCompareStory(s2[a], s2[b]) < 0 &&
                            QN_MapCompareStory(s2[b], s2[c]) < 0)
                            CHECK(QN_MapCompareStory(s2[a], s2[c]) < 0);
                        if (QN_MapCompareStory(s2[a], s2[b]) == 0 &&
                            QN_MapCompareStory(s2[b], s2[c]) == 0)
                            CHECK(QN_MapCompareStory(s2[a], s2[c]) == 0);
                    }
        }
        {
            static const char *const dmtr[] = {
                "lqdm1", "lqdm10", "lqdmX", "lqdm", "lqdm0", "lqdm01",
                "lqdm123456789", "lqdm12345678", "lqdm_1", "junk"
            };
            int dn2 = (int)(sizeof(dmtr)/sizeof(dmtr[0]));
            int a, b, c;
            for (a = 0; a < dn2; a++)
                for (b = 0; b < dn2; b++)
                    for (c = 0; c < dn2; c++) {
                        if (QN_MapCompareDm(dmtr[a], dmtr[b]) < 0 &&
                            QN_MapCompareDm(dmtr[b], dmtr[c]) < 0)
                            CHECK(QN_MapCompareDm(dmtr[a], dmtr[c]) < 0);
                        if (QN_MapCompareDm(dmtr[a], dmtr[b]) == 0 &&
                            QN_MapCompareDm(dmtr[b], dmtr[c]) == 0)
                            CHECK(QN_MapCompareDm(dmtr[a], dmtr[c]) == 0);
                    }
        }
    }
}

int qn_test_maps(int *checks_out);
int qn_test_maps(int *checks_out)
{
    checks = 0;
    failures = 0;
    test_pool();
    test_order();
    test_bounds();
    *checks_out = checks;
    return failures ? 1 : 0;
}
