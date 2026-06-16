"""Binary-search for the test that contaminates test_help_text_contains_global_option."""
import subprocess

TARGET = "tests/test_stats_command.py::TestStatsCLI::test_help_text_contains_global_option"

# Collect ordered test list
collect = subprocess.run(
    ["uv", "run", "pytest", "-n", "0", "-m", "not slow", "--co", "-q", "--no-header"],
    capture_output=True, text=True
)
tests = [line for line in collect.stdout.splitlines() if line.startswith("tests/") and "::" in line]
target_idx = next(i for i, t in enumerate(tests) if "test_help_text_contains_global_option" in t)
print(f"Target at index {target_idx} of {len(tests)}")

def run_slice(prefix_tests):
    """Run a slice of tests then the target; return True if target fails."""
    run = subprocess.run(
        ["uv", "run", "pytest", "-n", "0", "-p", "no:randomly", "-q", "--no-header", "--tb=no"] + prefix_tests + [TARGET],
        capture_output=True, text=True
    )
    return "1 failed" in run.stdout or "FAILED" in run.stdout

# Binary search: find smallest prefix that causes failure
lo, hi = 0, target_idx - 1
while lo < hi:
    mid = (lo + hi) // 2
    prefix = tests[:mid + 1]
    fails = run_slice(prefix)
    print(f"  lo={lo} mid={mid} hi={hi} prefix_len={len(prefix)} fails={fails}")
    if fails:
        hi = mid
    else:
        lo = mid + 1

print(f"\nSmallest failing prefix ends at index {lo}: {tests[lo]}")
# Verify
result = run_slice([tests[lo]])
print(f"Single-test contaminator confirmed: {result}")
