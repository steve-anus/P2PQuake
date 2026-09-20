/* test_main.c — the single entry for the C suites (make check links every C
 * file under tests/ into one binary). Each suite reports its own failures with
 * file:line context; this main owns the aggregate line the doors grep. */
#include <stdio.h>

int qn_test_frame(int *checks_out);
int qn_test_transport(int *checks_out);
int qn_test_spawn(int *checks_out);

int main(void)
{
    setvbuf(stdout, NULL, _IONBF, 0); /* FAIL trail visible even if a test hangs */
    int c_frame = 0, c_transport = 0, c_spawn = 0;
    int failed;

    failed = qn_test_frame(&c_frame);
    failed += qn_test_transport(&c_transport);
    failed += qn_test_spawn(&c_spawn);

    if (failed) {
        printf("QN_TESTS FAILED: %d checks\n", c_frame + c_transport + c_spawn);
        return 1;
    }
    printf("QN_TESTS OK: %d checks\n", c_frame + c_transport + c_spawn);
    return 0;
}
