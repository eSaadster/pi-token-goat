// Tests for token_goat.bash_parser.
import { describe, test, expect } from "vitest";
import { parse } from "../src/token_goat/bash_parser.js";

// ---------------------------------------------------------------------------
// 1. cat foo.py → read
// ---------------------------------------------------------------------------

test("cat_simple", () => {
  const intent = parse("cat foo.py");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.py");
  expect(intent.limit).toBeNull();
  expect(intent.offset).toBeNull();
});

// 2. head -n 50 foo.py → read, limit=50
test("head_n_flag_space", () => {
  const intent = parse("head -n 50 foo.py");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.py");
  expect(intent.limit).toBe(50);
});

// 3. head -n50 foo.py → read, limit=50 (concatenated flag)
test("head_n_flag_concat", () => {
  const intent = parse("head -n50 foo.py");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.py");
  expect(intent.limit).toBe(50);
});

// 4. head --lines=50 foo.py → read, limit=50
test("head_lines_eq", () => {
  const intent = parse("head --lines=50 foo.py");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.py");
  expect(intent.limit).toBe(50);
});

// 5. rg pattern src/ → grep, pattern=pattern
test("rg_simple", () => {
  const intent = parse("rg pattern src/");
  expect(intent.kind).toBe("grep");
  expect(intent.pattern).toBe("pattern");
});

// 6. grep -n 'foo bar' --color file.py → grep, pattern='foo bar'
test("grep_quoted_pattern", () => {
  const intent = parse("grep -n 'foo bar' --color file.py");
  expect(intent.kind).toBe("grep");
  expect(intent.pattern).toBe("foo bar");
});

// 7. find . -name '*.py' → glob
test("find_glob", () => {
  const intent = parse("find . -name '*.py'");
  expect(intent.kind).toBe("glob");
});

// 8. sudo prefix stripping with system path guard
test("sudo_prefix_stripped", () => {
  const intent = parse("sudo cat /etc/passwd");
  expect(intent.kind).toBe("unknown");
  expect(intent.reason).toContain("system path");
});

test("sudo_prefix_stripped_project_file", () => {
  const intent = parse("sudo cat src/main.py");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("src/main.py");
});

// 9. VAR=value cat foo → read, target=foo (strips env assignment)
test("env_prefix_stripped", () => {
  const intent = parse("VAR=value cat foo");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo");
});

// 10. unknown binary → unknown
test("unknown_binary", () => {
  const intent = parse("garbage");
  expect(intent.kind).toBe("unknown");
});

// 11. pipe: only leading segment is inspected
test("pipe_leading_command", () => {
  const intent = parse("cat README.md | grep foo");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("README.md");
});

// 12. tail -n 20 file.txt → read, limit=20
test("tail_n_flag", () => {
  const intent = parse("tail -n 20 file.txt");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("file.txt");
  expect(intent.limit).toBe(20);
});

// 13. bat src/main.rs → read
test("bat_read", () => {
  const intent = parse("bat src/main.rs");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("src/main.rs");
});

// 13b. other read-like commands → read
describe("additional_read_like_commands", () => {
  test.each([
    ["less README.md", "README.md"],
    ["more README.md", "README.md"],
    ["zless README.md", "README.md"],
    ["zmore README.md", "README.md"],
    ["batcat README.md", "README.md"],
    ["nl README.md", "README.md"],
    ["cat -n README.md", "README.md"],
    ["awk 'BEGIN { print }' src/main.py", "src/main.py"],
    ["perl -ne 'print' src/main.py", "src/main.py"],
  ])("%s", (command, targetPath) => {
    const intent = parse(command);
    expect(intent.kind).toBe("read");
    expect(intent.target_path).toBe(targetPath);
  });
});

// 14a. zcat file.txt → read
test("zcat_read", () => {
  const intent = parse("zcat docs/notes.txt");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("docs/notes.txt");
});

// 14b. sed -n '1,20p' file.py → read
test("sed_scripted_read", () => {
  const intent = parse("sed -n '1,20p' src/main.py");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("src/main.py");
});

// 14c. sed / perl -i... 's/a/b/' file.py → unknown
describe("scripted_in_place_not_read", () => {
  test.each([
    "sed -i 's/a/b/' src/main.py",
    "sed --in-place 's/a/b/' src/main.py",
    "perl -i.bak -ne 'print' src/main.py",
  ])("%s", (command) => {
    const intent = parse(command);
    expect(intent.kind).toBe("unknown");
    expect(intent.reason).not.toBeNull();
    expect(intent.reason).toContain("in place");
  });
});

// 14. rg -e 'mypattern' → grep via -e flag
test("rg_e_flag", () => {
  const intent = parse("rg -e 'mypattern' src/");
  expect(intent.kind).toBe("grep");
  expect(intent.pattern).toBe("mypattern");
});

// 15. fd -e ts → glob
test("fd_glob", () => {
  const intent = parse("fd -e ts");
  expect(intent.kind).toBe("glob");
});

// 16. empty / whitespace → unknown
test("empty_command", () => {
  const intent = parse("");
  expect(intent.kind).toBe("unknown");
});

test("whitespace_only", () => {
  const intent = parse("   ");
  expect(intent.kind).toBe("unknown");
});

// 17. Additional read-equivalent binaries (xxd, od, wc, type)
describe("binary_dump_and_count_readers", () => {
  test.each([
    ["xxd binary.bin", "binary.bin"],
    ["od -c binary.bin", "binary.bin"],
    ["wc -l README.md", "README.md"],
    ["wc README.md", "README.md"],
    ["type foo.txt", "foo.txt"],
  ])("%s", (command, targetPath) => {
    const intent = parse(command);
    expect(intent.kind).toBe("read");
    expect(intent.target_path).toBe(targetPath);
  });
});

// 18. PowerShell Get-Content / gc
test("powershell_get_content_positional", () => {
  const intent = parse("Get-Content foo.txt");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.txt");
  expect(intent.limit).toBeNull();
});

test("powershell_get_content_case_insensitive", () => {
  const intent = parse("GET-CONTENT foo.txt");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.txt");
});

test("powershell_gc_alias", () => {
  const intent = parse("gc foo.txt");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.txt");
});

test("powershell_get_content_path_flag", () => {
  const intent = parse("Get-Content -Path foo.txt");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.txt");
});

test("powershell_get_content_literalpath_flag", () => {
  const intent = parse("Get-Content -LiteralPath foo.txt");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.txt");
});

test("powershell_get_content_totalcount_offset", () => {
  const intent = parse("Get-Content -Path foo.txt -TotalCount 50");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.txt");
  expect(intent.offset).toBe(1);
  expect(intent.limit).toBe(50);
});

test("powershell_get_content_tail_no_offset", () => {
  const intent = parse("Get-Content foo.txt -Tail 20");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.txt");
  expect(intent.offset).toBeNull();
  expect(intent.limit).toBe(20);
});

test("powershell_get_content_skip_encoding_arg", () => {
  const intent = parse("Get-Content -Encoding utf8 foo.txt");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.txt");
});

// 19. Stdin redirection (cmd < FILE) — treated as read of FILE
test("redirect_cat_lt_file", () => {
  const intent = parse("cat < foo.txt");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.txt");
});

test("redirect_wc_lt_file", () => {
  const intent = parse("wc -l < foo.txt");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.txt");
});

test("redirect_unknown_binary_lt_file", () => {
  const intent = parse("python_script.py < foo.txt");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.txt");
});

test("redirect_attached_form", () => {
  const intent = parse("cat <foo.txt");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.txt");
});

// 20. Heredoc / here-string — must NOT be classified as a read
test("heredoc_not_a_read", () => {
  const intent = parse("cat << EOF");
  expect(intent.kind).toBe("unknown");
  expect(intent.reason).not.toBeNull();
  expect(intent.reason).toContain("heredoc");
});

test("here_string_not_a_read", () => {
  const intent = parse("cat <<< 'foo bar'");
  expect(intent.kind).toBe("unknown");
  expect(intent.reason).not.toBeNull();
  expect(intent.reason).toContain("heredoc");
});

// 21. head extracts offset=1 alongside limit
test("head_records_offset_one", () => {
  const intent = parse("head -n 50 foo.py");
  expect(intent.kind).toBe("read");
  expect(intent.offset).toBe(1);
  expect(intent.limit).toBe(50);
});

test("tail_records_limit_only", () => {
  const intent = parse("tail -n 20 file.txt");
  expect(intent.kind).toBe("read");
  expect(intent.offset).toBeNull();
  expect(intent.limit).toBe(20);
});

describe("tail_skip_to_line_sets_offset", () => {
  test.each([
    ["tail -n +10 file.py", 10],
    ["tail -n +1 file.py", 1],
    ["tail -n +100 src/main.py", 100],
    ["tail -n+50 file.py", 50],
    ["tail --lines +25 file.py", 25],
    ["tail -n +0 file.py", 1],
  ])("%s", (cmd, expectedOffset) => {
    const intent = parse(cmd);
    expect(intent.kind).toBe("read");
    expect(intent.offset).toBe(expectedOffset);
    expect(intent.limit).toBeNull();
  });
});

test("tail_plain_n_does_not_set_offset", () => {
  const intent = parse("tail -n 20 file.txt");
  expect(intent.offset).toBeNull();
  expect(intent.limit).toBe(20);
});

// 22. sed -n 'M,Np' line-range extraction
describe("sed_line_range_extraction", () => {
  test.each([
    ["sed -n '10,20p' src/main.py", 10, 11],
    ["sed -n '5p' src/main.py", 5, 1],
    ["sed -n '1,100p' README.md", 1, 100],
  ])("%s", (command, offset, limit) => {
    const intent = parse(command);
    expect(intent.kind).toBe("read");
    expect(intent.offset).toBe(offset);
    expect(intent.limit).toBe(limit);
  });
});

test("sed_inverted_range_falls_through", () => {
  const intent = parse("sed -n '20,10p' src/main.py");
  expect(intent.kind).toBe("read");
  expect(intent.offset).toBeNull();
  expect(intent.limit).toBeNull();
});

test("sed_unknown_script_no_range", () => {
  const intent = parse("sed -n '/foo/p' src/main.py");
  expect(intent.kind).toBe("read");
  expect(intent.offset).toBeNull();
  expect(intent.limit).toBeNull();
});

// 23. awk NR slice extraction
describe("awk_line_range_extraction", () => {
  test.each([
    ["awk 'NR==5' src/main.py", 5, 1],
    ["awk 'NR>=10 && NR<=20' src/main.py", 10, 11],
    ["awk 'NR >= 10 && NR <= 20' src/main.py", 10, 11],
  ])("%s", (command, offset, limit) => {
    const intent = parse(command);
    expect(intent.kind).toBe("read");
    expect(intent.offset).toBe(offset);
    expect(intent.limit).toBe(limit);
  });
});

test("awk_complex_script_no_range", () => {
  const intent = parse("awk '/foo/ { print }' src/main.py");
  expect(intent.kind).toBe("read");
  expect(intent.offset).toBeNull();
  expect(intent.limit).toBeNull();
});

// 24. Combined: pipe + redirect — leading segment still recognised
test("pipe_with_head_offset", () => {
  const intent = parse("head -n 30 foo.py | grep bar");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.py");
  expect(intent.offset).toBe(1);
  expect(intent.limit).toBe(30);
});

// 25. PowerShell pipeline filter detection
test("powershell_pipe_select_string_positional", () => {
  const intent = parse("Get-Content foo.txt | Select-String 'mypat'");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.txt");
  expect(intent.filtered).toBe(true);
  expect(intent.filter_pattern).toBe("mypat");
});

test("powershell_pipe_select_string_pattern_flag", () => {
  const intent = parse("Get-Content foo.txt | Select-String -Pattern 'foo bar'");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.txt");
  expect(intent.filtered).toBe(true);
  expect(intent.filter_pattern).toBe("foo bar");
});

test("powershell_pipe_sls_alias", () => {
  const intent = parse("gc foo.txt | sls 'needle'");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.txt");
  expect(intent.filtered).toBe(true);
  expect(intent.filter_pattern).toBe("needle");
});

test("powershell_pipe_where_object_match", () => {
  const intent = parse("Get-Content foo.txt | Where-Object { $_ -match 'needle' }");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.txt");
  expect(intent.filtered).toBe(true);
  expect(intent.filter_pattern).toBe("needle");
});

test("powershell_pipe_where_alias_question_mark", () => {
  const intent = parse("gc foo.txt | ? { $_ -match 'pat' }");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.txt");
  expect(intent.filtered).toBe(true);
  expect(intent.filter_pattern).toBe("pat");
});

test("powershell_pipe_select_object_first", () => {
  const intent = parse("Get-Content foo.txt | Select-Object -First 10");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.txt");
  expect(intent.offset).toBe(1);
  expect(intent.limit).toBe(10);
  expect(intent.filtered).toBe(false);
});

test("powershell_pipe_select_first_alias", () => {
  const intent = parse("gc foo.txt | select -First 5");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.txt");
  expect(intent.offset).toBe(1);
  expect(intent.limit).toBe(5);
});

test("powershell_pipe_select_last", () => {
  const intent = parse("Get-Content foo.txt | Select-Object -Last 3");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.txt");
  expect(intent.offset).toBeNull();
  expect(intent.limit).toBe(3);
});

test("powershell_pipe_out_string_passthrough", () => {
  const intent = parse("Get-Content foo.txt | Out-String -Width 200");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.txt");
  expect(intent.filtered).toBe(false);
  expect(intent.limit).toBeNull();
});

test("powershell_pipe_combined_filter_and_limit", () => {
  const intent = parse("gc foo.txt | ? { $_ -match 'foo' } | select -First 5");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.txt");
  expect(intent.filtered).toBe(true);
  expect(intent.filter_pattern).toBe("foo");
  expect(intent.offset).toBe(1);
  expect(intent.limit).toBe(5);
});

test("powershell_pipe_does_not_override_source_totalcount", () => {
  const intent = parse("Get-Content foo.txt -TotalCount 20 | Select-Object -First 5");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.txt");
  expect(intent.offset).toBe(1);
  expect(intent.limit).toBe(20);
});

test("powershell_pipe_unfiltered_passthrough_keeps_full_read", () => {
  const intent = parse("Get-Content foo.txt");
  expect(intent.kind).toBe("read");
  expect(intent.filtered).toBe(false);
  expect(intent.filter_pattern).toBeNull();
});

test("bash_pipe_unchanged_no_filtered_flag", () => {
  const intent = parse("cat foo.txt | grep bar");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.txt");
  expect(intent.filtered).toBe(false);
  expect(intent.filter_pattern).toBeNull();
});

// 26. type ambiguity guard
describe("type_with_path_like_argument_is_read", () => {
  test.each([
    ["type foo.txt", "foo.txt"],
    ["type ./foo", "./foo"],
    ["type ../foo", "../foo"],
    ["type src/main.py", "src/main.py"],
    ["type ~/notes.md", "~/notes.md"],
    ['type "C:\\config.ini"', "C:\\config.ini"],
    ["TYPE README.md", "README.md"],
  ])("%s", (command, expectedPath) => {
    const intent = parse(command);
    expect(intent.kind).toBe("read");
    expect(intent.target_path).toBe(expectedPath);
  });
});

describe("type_with_bare_identifier_is_unknown", () => {
  test.each(["type ls", "type git", "type python", "type cd"])(
    "%s",
    (command) => {
      const intent = parse(command);
      expect(intent.kind).toBe("unknown");
      expect(intent.reason).not.toBeNull();
      expect(intent.reason).toContain("type");
    },
  );
});

// 27. PowerShell Get-Content — additional inline-equals flag forms
test("powershell_get_content_path_equals_form", () => {
  const intent = parse("Get-Content -Path=foo.txt");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.txt");
});

test("powershell_get_content_literalpath_equals_form", () => {
  const intent = parse("Get-Content -LiteralPath=foo.txt");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.txt");
});

test("powershell_get_content_literalpath_with_spaces", () => {
  const intent = parse('Get-Content -LiteralPath "my file with spaces.txt"');
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("my file with spaces.txt");
});

test("powershell_get_content_path_with_spaces", () => {
  const intent = parse('Get-Content "path/to/my file.txt"');
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("path/to/my file.txt");
});

test("powershell_get_content_totalcount_equals_form", () => {
  const intent = parse("Get-Content -Path=foo.txt -TotalCount=50");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.txt");
  expect(intent.offset).toBe(1);
  expect(intent.limit).toBe(50);
});

test("powershell_get_content_tail_equals_form", () => {
  const intent = parse("Get-Content foo.txt -Tail=20");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.txt");
  expect(intent.offset).toBeNull();
  expect(intent.limit).toBe(20);
});

test("powershell_get_content_first_alias", () => {
  const intent = parse("Get-Content foo.txt -First 10");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.txt");
  expect(intent.offset).toBe(1);
  expect(intent.limit).toBe(10);
});

test("powershell_get_content_last_alias", () => {
  const intent = parse("Get-Content foo.txt -Last 5");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("foo.txt");
  expect(intent.offset).toBeNull();
  expect(intent.limit).toBe(5);
});

// Interactive pagers (less, more)
test("less_interactive_pager", () => {
  const intent = parse("less src/main.rs");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("src/main.rs");
  expect(intent.is_interactive_pager).toBe(true);
});

test("more_interactive_pager", () => {
  const intent = parse("more /var/log/syslog");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("/var/log/syslog");
  expect(intent.is_interactive_pager).toBe(true);
});

test("less_with_flags", () => {
  const intent = parse("less -N file.txt");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("file.txt");
  expect(intent.is_interactive_pager).toBe(true);
});

// grep/rg read-equivalents (trivial patterns matching everything)
test("grep_empty_pattern_is_read_equivalent", () => {
  const intent = parse('grep "" src/main.py');
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("src/main.py");
});

test("rg_dot_pattern_is_read_equivalent", () => {
  const intent = parse('rg "." README.md');
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("README.md");
});

test("grep_nontrivial_pattern_is_grep", () => {
  const intent = parse('grep "TODO" src/main.py');
  expect(intent.kind).toBe("grep");
  expect(intent.pattern).toBe("TODO");
});

test("rg_nontrivial_pattern_is_grep", () => {
  const intent = parse('rg "error" logs/');
  expect(intent.kind).toBe("grep");
  expect(intent.pattern).toBe("error");
});

// System path guard
test("cat_etc_hosts_rejected", () => {
  const intent = parse("cat /etc/hosts");
  expect(intent.kind).toBe("unknown");
  expect(intent.reason).toContain("system path");
});

test("cat_windows_system32_rejected", () => {
  const intent = parse('cat "C:\\Windows\\System32\\drivers\\etc\\hosts"');
  expect(intent.kind).toBe("unknown");
  expect(intent.reason).toContain("system path");
});

test("cat_etc_passwd_rejected", () => {
  const intent = parse("cat /etc/passwd");
  expect(intent.kind).toBe("unknown");
  expect(intent.reason).toContain("system path");
});

test("cat_sys_rejected", () => {
  const intent = parse("cat /sys/devices/pci0000:00/0000:00:00.0/uevent");
  expect(intent.kind).toBe("unknown");
  expect(intent.reason).toContain("system path");
});

test("cat_program_files_rejected", () => {
  const intent = parse('cat "C:\\Program Files\\Python\\python.exe"');
  expect(intent.kind).toBe("unknown");
  expect(intent.reason).toContain("system path");
});

test("cat_project_file_accepted", () => {
  const intent = parse("cat src/main.py");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("src/main.py");
});

test("less_etc_logs_rejected", () => {
  const intent = parse("less /etc/sudoers");
  expect(intent.kind).toBe("unknown");
  expect(intent.reason).toContain("system path");
});

test("grep_empty_on_system_path_rejected", () => {
  const intent = parse('grep "" /etc/hostname');
  expect(intent.kind).toBe("unknown");
  expect(intent.reason).toContain("system path");
});

// 28. Multi-file cat
test("cat_two_files_target_paths", () => {
  const intent = parse("cat file1.py file2.py");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("file1.py");
  expect(intent.target_paths).toEqual(["file1.py", "file2.py"]);
});

test("cat_three_files_target_paths", () => {
  const intent = parse("cat a.py b.py c.py");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("a.py");
  expect(intent.target_paths).toEqual(["a.py", "b.py", "c.py"]);
});

test("cat_single_file_no_target_paths", () => {
  const intent = parse("cat file.py");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("file.py");
  expect(intent.target_paths).toBeNull();
});

test("cat_multi_file_with_flags", () => {
  const intent = parse("cat -n file1.py file2.py");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("file1.py");
  expect(intent.target_paths).toEqual(["file1.py", "file2.py"]);
});

test("cat_multi_file_system_path_excluded", () => {
  const intent = parse("cat file.py /etc/hosts other.py");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("file.py");
  expect(intent.target_paths).toEqual(["file.py", "other.py"]);
});

test("cat_multi_file_quoted_spaces", () => {
  const intent = parse('cat "dir with spaces/a.py" "dir with spaces/b.py"');
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("dir with spaces/a.py");
  expect(intent.target_paths).toEqual([
    "dir with spaces/a.py",
    "dir with spaces/b.py",
  ]);
});

// 29. jq / yq read-equivalent detection
test("jq_dot_filter_is_read", () => {
  const intent = parse("jq '.' config.json");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("config.json");
  expect(intent.target_paths).toBeNull();
});

test("yq_dot_filter_is_read", () => {
  const intent = parse("yq '.' config.yaml");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("config.yaml");
});

test("jq_with_raw_output_flag_is_read", () => {
  const intent = parse("jq -r '.' config.json");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("config.json");
});

test("jq_with_compact_flag_is_read", () => {
  const intent = parse("jq -c '.' config.json");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("config.json");
});

test("jq_nontrivial_filter_is_unknown", () => {
  const intent = parse("jq '.foo' config.json");
  expect(intent.kind).toBe("unknown");
  expect(intent.reason).toContain("non-trivial filter");
});

test("jq_complex_filter_is_unknown", () => {
  const intent = parse("jq '.[] | .name' items.json");
  expect(intent.kind).toBe("unknown");
});

test("jq_no_file_is_unknown", () => {
  const intent = parse("jq '.'");
  expect(intent.kind).toBe("unknown");
  expect(intent.reason).toContain("stdin");
});

test("jq_no_args_is_unknown", () => {
  const intent = parse("jq");
  expect(intent.kind).toBe("unknown");
});

test("jq_system_path_rejected", () => {
  const intent = parse("jq '.' /etc/hosts");
  expect(intent.kind).toBe("unknown");
});

test("jq_multi_file_target_paths", () => {
  const intent = parse("jq '.' a.json b.json");
  expect(intent.kind).toBe("read");
  expect(intent.target_path).toBe("a.json");
  expect(intent.target_paths).toEqual(["a.json", "b.json"]);
});

test("yq_nontrivial_filter_is_unknown", () => {
  const intent = parse("yq '.metadata.name' pod.yaml");
  expect(intent.kind).toBe("unknown");
});

// PowerShell Get-Content — additional flag aliases and filter operators
describe("GetContentAdditionalCoverage", () => {
  test("get_content_head_flag_alias", () => {
    const intent = parse("Get-Content foo.py -Head 15");
    expect(intent.kind).toBe("read");
    expect(intent.target_path).toBe("foo.py");
    expect(intent.offset).toBe(1);
    expect(intent.limit).toBe(15);
  });

  test("gc_head_flag_alias", () => {
    const intent = parse("gc foo.py -Head 5");
    expect(intent.kind).toBe("read");
    expect(intent.target_path).toBe("foo.py");
    expect(intent.offset).toBe(1);
    expect(intent.limit).toBe(5);
  });

  test("where_object_like_operator_captured", () => {
    const intent = parse("gc foo.txt | ? { $_ -like '*needle*' }");
    expect(intent.kind).toBe("read");
    expect(intent.target_path).toBe("foo.txt");
    expect(intent.filtered).toBe(true);
    expect(intent.filter_pattern).toBe("*needle*");
  });

  test("where_object_imatch_operator_captured", () => {
    const intent = parse("Get-Content foo.txt | ? { $_ -imatch 'ErrorLevel' }");
    expect(intent.kind).toBe("read");
    expect(intent.target_path).toBe("foo.txt");
    expect(intent.filtered).toBe(true);
    expect(intent.filter_pattern).toBe("ErrorLevel");
  });

  test("get_content_no_args_is_unknown", () => {
    const intent = parse("Get-Content");
    expect(intent.kind).toBe("unknown");
  });

  test("gc_no_args_is_unknown", () => {
    const intent = parse("gc");
    expect(intent.kind).toBe("unknown");
  });
});

// PowerShell Get-Content — new capabilities
describe("GetContentNewCapabilities", () => {
  test("get_content_wait_is_interactive_pager", () => {
    const intent = parse("Get-Content app.log -Wait");
    expect(intent.kind).toBe("read");
    expect(intent.target_path).toBe("app.log");
    expect(intent.is_interactive_pager).toBe(true);
  });

  test("gc_wait_is_interactive_pager", () => {
    const intent = parse("gc service.log -Wait");
    expect(intent.kind).toBe("read");
    expect(intent.target_path).toBe("service.log");
    expect(intent.is_interactive_pager).toBe(true);
  });

  test("get_content_wait_no_limit", () => {
    const intent = parse("Get-Content C:/logs/app.log -Wait");
    expect(intent.kind).toBe("read");
    expect(intent.target_path).toBe("C:/logs/app.log");
    expect(intent.limit).toBeNull();
    expect(intent.is_interactive_pager).toBe(true);
  });

  test("get_content_without_wait_not_pager", () => {
    const intent = parse("Get-Content app.log");
    expect(intent.kind).toBe("read");
    expect(intent.is_interactive_pager).toBe(false);
  });

  test("get_content_two_files_positional", () => {
    const intent = parse("gc file1.txt file2.txt");
    expect(intent.kind).toBe("read");
    expect(intent.target_path).toBe("file1.txt");
    expect(intent.target_paths).toEqual(["file1.txt", "file2.txt"]);
  });

  test("get_content_three_files", () => {
    const intent = parse("Get-Content a.log b.log c.log");
    expect(intent.kind).toBe("read");
    expect(intent.target_path).toBe("a.log");
    expect(intent.target_paths).toEqual(["a.log", "b.log", "c.log"]);
  });

  test("get_content_single_file_target_paths_is_none", () => {
    const intent = parse("Get-Content only.txt");
    expect(intent.kind).toBe("read");
    expect(intent.target_path).toBe("only.txt");
    expect(intent.target_paths).toBeNull();
  });

  test("sort_object_is_passthrough", () => {
    const intent = parse("Get-Content data.txt | Sort-Object");
    expect(intent.kind).toBe("read");
    expect(intent.target_path).toBe("data.txt");
    expect(intent.filtered).toBe(false);
  });

  test("sort_alias_is_passthrough", () => {
    const intent = parse("gc data.txt | sort");
    expect(intent.kind).toBe("read");
    expect(intent.filtered).toBe(false);
  });

  test("foreach_object_is_passthrough", () => {
    const intent = parse("Get-Content file.txt | ForEach-Object { $_ }");
    expect(intent.kind).toBe("read");
    expect(intent.target_path).toBe("file.txt");
    expect(intent.filtered).toBe(false);
  });

  test("foreach_percent_alias_is_passthrough", () => {
    const intent = parse("gc file.txt | % { $_ }");
    expect(intent.kind).toBe("read");
    expect(intent.filtered).toBe(false);
  });

  test("tee_object_is_passthrough", () => {
    const intent = parse("Get-Content src.txt | Tee-Object -FilePath copy.txt");
    expect(intent.kind).toBe("read");
    expect(intent.target_path).toBe("src.txt");
    expect(intent.filtered).toBe(false);
  });

  test("measure_object_is_passthrough", () => {
    const intent = parse("Get-Content data.csv | Measure-Object -Line");
    expect(intent.kind).toBe("read");
    expect(intent.filtered).toBe(false);
  });

  test("convertto_json_is_passthrough", () => {
    const intent = parse("Get-Content config.txt | ConvertTo-Json");
    expect(intent.kind).toBe("read");
    expect(intent.target_path).toBe("config.txt");
    expect(intent.filtered).toBe(false);
  });

  test("group_object_is_passthrough", () => {
    const intent = parse("gc events.log | Group-Object");
    expect(intent.kind).toBe("read");
    expect(intent.filtered).toBe(false);
  });

  test("where_notmatch_sets_filtered_and_captures_pattern", () => {
    const intent = parse("gc app.log | ? { $_ -notmatch 'DEBUG' }");
    expect(intent.kind).toBe("read");
    expect(intent.target_path).toBe("app.log");
    expect(intent.filtered).toBe(true);
    expect(intent.filter_pattern).toBe("DEBUG");
  });

  test("where_notlike_sets_filtered_and_captures_pattern", () => {
    const intent = parse("Get-Content log.txt | ? { $_ -notlike '*TRACE*' }");
    expect(intent.kind).toBe("read");
    expect(intent.filtered).toBe(true);
    expect(intent.filter_pattern).toBe("*TRACE*");
  });

  test("where_cnotmatch_sets_filtered", () => {
    const intent = parse("gc file.txt | ? { $_ -cnotmatch 'Error' }");
    expect(intent.kind).toBe("read");
    expect(intent.filtered).toBe(true);
    expect(intent.filter_pattern).toBe("Error");
  });

  test("where_inotmatch_sets_filtered", () => {
    const intent = parse("gc file.txt | ? { $_ -inotmatch 'warning' }");
    expect(intent.kind).toBe("read");
    expect(intent.filtered).toBe(true);
    expect(intent.filter_pattern).toBe("warning");
  });

  test("stream_after_path_does_not_add_stream_name_as_target", () => {
    const intent = parse("gc file.txt -Stream Zone.Identifier");
    expect(intent.kind).toBe("read");
    expect(intent.target_path).toBe("file.txt");
    expect(intent.target_paths).toBeNull();
  });

  test("stream_before_path_is_consumed", () => {
    const intent = parse("gc -Stream Zone.Identifier file.txt");
    expect(intent.kind).toBe("read");
    expect(intent.target_path).toBe("file.txt");
    expect(intent.target_paths).toBeNull();
  });

  test("readcount_after_path_does_not_add_count_as_target", () => {
    const intent = parse("gc file.txt -ReadCount 10");
    expect(intent.kind).toBe("read");
    expect(intent.target_path).toBe("file.txt");
    expect(intent.target_paths).toBeNull();
    expect(intent.limit).toBeNull();
  });

  test("readcount_before_path_is_consumed", () => {
    const intent = parse("gc -ReadCount 5 file.txt");
    expect(intent.kind).toBe("read");
    expect(intent.target_path).toBe("file.txt");
    expect(intent.target_paths).toBeNull();
  });

  test("encoding_after_path_does_not_add_encoding_as_target", () => {
    const intent = parse("gc file.txt -Encoding UTF8");
    expect(intent.kind).toBe("read");
    expect(intent.target_path).toBe("file.txt");
    expect(intent.target_paths).toBeNull();
  });

  test("delimiter_after_path_does_not_add_delimiter_as_target", () => {
    const intent = parse("gc file.txt -Delimiter ,");
    expect(intent.kind).toBe("read");
    expect(intent.target_path).toBe("file.txt");
    expect(intent.target_paths).toBeNull();
  });

  test("asbyte_stream_is_full_read", () => {
    const intent = parse("Get-Content file.bin -AsByteStream");
    expect(intent.kind).toBe("read");
    expect(intent.target_path).toBe("file.bin");
    expect(intent.limit).toBeNull();
    expect(intent.offset).toBeNull();
    expect(intent.is_interactive_pager).toBe(false);
  });

  test("asbyte_stream_on_image_is_read", () => {
    const intent = parse("Get-Content image.png -AsByteStream");
    expect(intent.kind).toBe("read");
    expect(intent.target_path).toBe("image.png");
  });

  test("full_cmdlet_stream_after_path", () => {
    const intent = parse("Get-Content notes.txt -Stream Zone.Identifier");
    expect(intent.kind).toBe("read");
    expect(intent.target_path).toBe("notes.txt");
    expect(intent.target_paths).toBeNull();
  });

  test("multi_file_unaffected_by_stream_fix", () => {
    const intent = parse("gc file1.txt file2.txt");
    expect(intent.kind).toBe("read");
    expect(intent.target_path).toBe("file1.txt");
    expect(intent.target_paths).toEqual(["file1.txt", "file2.txt"]);
  });
});
