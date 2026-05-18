# /// script
# requires-python = ">=3.10"
# dependencies = ["pytest>=8.0.0"]
# ///
"""Tests for stitch_video.py — argparse, validation, and command construction.

These tests do NOT invoke real ffmpeg; they shell out to a recording stub
so the suite runs without ffmpeg installed and without depending on Veo
fixture videos.
"""

from __future__ import annotations

import os
import stat
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

import stitch_video as sv  # noqa: E402


def _args(**overrides) -> SimpleNamespace:
    base = dict(inputs=None, filename="out.mp4", audio=None, ffmpeg="ffmpeg")
    base.update(overrides)
    return SimpleNamespace(**base)


# --- _contains_concat_breaker -----------------------------------------------


def test_contains_concat_breaker_flags_newline():
    assert sv._contains_concat_breaker("a\nb")


def test_contains_concat_breaker_flags_carriage_return():
    assert sv._contains_concat_breaker("a\rb")


def test_contains_concat_breaker_accepts_normal_paths():
    assert not sv._contains_concat_breaker("/tmp/foo bar.mp4")
    assert not sv._contains_concat_breaker("/tmp/o'brien.mp4")


def _touch_mp4(path: Path) -> str:
    path.write_bytes(b"FAKEMP4")
    return str(path)


# --- validate_inputs ---------------------------------------------------------


def test_validate_requires_two_inputs():
    ok, err = sv.validate_inputs(_args(inputs=["a.mp4"]))
    assert not ok
    assert "At least 2" in err


def test_validate_rejects_missing_input(tmp_path):
    ok, err = sv.validate_inputs(_args(inputs=[str(tmp_path / "missing.mp4")] * 2))
    assert not ok
    assert "not found" in err


def test_validate_rejects_non_mp4(tmp_path):
    a = _touch_mp4(tmp_path / "a.mp4")
    mov = tmp_path / "b.mov"
    mov.write_bytes(b"MOV")
    ok, err = sv.validate_inputs(_args(inputs=[a, str(mov)]))
    assert not ok
    assert ".mp4" in err


def test_validate_rejects_missing_audio(tmp_path):
    a = _touch_mp4(tmp_path / "a.mp4")
    b = _touch_mp4(tmp_path / "b.mp4")
    ok, err = sv.validate_inputs(
        _args(inputs=[a, b], audio=str(tmp_path / "missing.mp3"))
    )
    assert not ok
    assert "Audio not found" in err


def test_validate_accepts_happy_path(tmp_path):
    a = _touch_mp4(tmp_path / "a.mp4")
    b = _touch_mp4(tmp_path / "b.mp4")
    ok, err = sv.validate_inputs(_args(inputs=[a, b]))
    assert ok and err is None


def test_validate_rejects_newline_in_input_path(tmp_path):
    a = _touch_mp4(tmp_path / "a.mp4")
    # Smuggled-newline input would inject a `file '...'` directive into the
    # concat demuxer list. Reject before ffmpeg ever sees it.
    ok, err = sv.validate_inputs(_args(inputs=[a, "evil\nfile '/etc/passwd'\nx.mp4"]))
    assert not ok
    assert "newline" in err


def test_validate_rejects_carriage_return_in_input_path(tmp_path):
    a = _touch_mp4(tmp_path / "a.mp4")
    ok, err = sv.validate_inputs(_args(inputs=[a, "evil\rfile.mp4"]))
    assert not ok


def test_validate_rejects_newline_in_audio_path(tmp_path):
    a = _touch_mp4(tmp_path / "a.mp4")
    b = _touch_mp4(tmp_path / "b.mp4")
    ok, err = sv.validate_inputs(
        _args(inputs=[a, b], audio="evil\nfile '/etc/passwd'\ny.mp3")
    )
    assert not ok
    assert "newline" in err


# --- write_concat_list -------------------------------------------------------


def test_concat_list_uses_absolute_quoted_paths(tmp_path):
    a = _touch_mp4(tmp_path / "a.mp4")
    b = _touch_mp4(tmp_path / "with space.mp4")
    list_path = tmp_path / "concat.txt"
    sv.write_concat_list([a, b], list_path)
    content = list_path.read_text()
    assert "file '" in content
    assert str(Path(a).resolve()) in content
    assert str(Path(b).resolve()) in content


def test_concat_list_escapes_single_quote_in_path(tmp_path):
    weird = tmp_path / "o'brien.mp4"
    weird.write_bytes(b"FAKE")
    list_path = tmp_path / "concat.txt"
    sv.write_concat_list([str(weird)], list_path)
    content = list_path.read_text()
    # The escaped form keeps the path inside single-quoted ffmpeg syntax.
    assert "'\\''" in content


# --- build_command -----------------------------------------------------------


def test_build_command_concat_only(tmp_path):
    args = _args(filename=str(tmp_path / "out.mp4"))
    list_path = tmp_path / "list.txt"
    cmd = sv.build_command(args, list_path, Path(args.filename))
    assert "concat" in cmd
    assert "-c" in cmd and cmd[cmd.index("-c") + 1] == "copy"
    # No second input (no audio overlay).
    assert cmd.count("-i") == 1


def test_build_command_with_audio_overlay_uses_two_inputs_and_reencode(tmp_path):
    args = _args(
        filename=str(tmp_path / "out.mp4"),
        audio=str(tmp_path / "music.mp3"),
    )
    list_path = tmp_path / "list.txt"
    cmd = sv.build_command(args, list_path, Path(args.filename))
    assert cmd.count("-i") == 2
    assert "libx264" in cmd
    assert "aac" in cmd
    assert "-shortest" in cmd
    # Video from concat, audio from the unified track.
    assert "-map" in cmd
    assert "0:v:0" in cmd
    assert "1:a:0" in cmd


# --- run() end-to-end with a stubbed ffmpeg ----------------------------------


def _install_fake_ffmpeg(tmp_path: Path, *, exit_code: int = 0) -> str:
    """Write a shell stub at tmp_path/fake-ffmpeg that:

    - Touches the file passed as its last argv (the output path).
    - Exits with the given code.

    Returns the absolute path to the stub.

    The stub uses /bin/bash explicitly because ${@: -1} (negative offset in
    parameter expansion) is a bashism; under dash (the default /bin/sh on
    Debian/Ubuntu, which is what the agent container runs) it errors.
    """
    stub = tmp_path / "fake-ffmpeg"
    stub.write_text(
        "#!/bin/bash\n"
        f"if [ {exit_code} -eq 0 ]; then\n"
        '  out="${@: -1}"\n'
        "  echo FAKEOUT > \"$out\"\n"
        "fi\n"
        f"exit {exit_code}\n"
    )
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return str(stub)


def test_run_happy_path_writes_output_and_emits_media(tmp_path, capsys):
    a = _touch_mp4(tmp_path / "a.mp4")
    b = _touch_mp4(tmp_path / "b.mp4")
    out = tmp_path / "out.mp4"
    fake = _install_fake_ffmpeg(tmp_path, exit_code=0)

    rc = sv.run(_args(inputs=[a, b], filename=str(out), ffmpeg=fake))
    assert rc == 0
    assert out.exists()

    final_line = capsys.readouterr().out.strip().splitlines()[-1]
    assert final_line.startswith("MEDIA: ")
    assert final_line.endswith(str(out.resolve()))


def test_run_propagates_ffmpeg_failure(tmp_path, capsys):
    a = _touch_mp4(tmp_path / "a.mp4")
    b = _touch_mp4(tmp_path / "b.mp4")
    out = tmp_path / "out.mp4"
    fake = _install_fake_ffmpeg(tmp_path, exit_code=2)

    rc = sv.run(_args(inputs=[a, b], filename=str(out), ffmpeg=fake))
    assert rc == 1
    captured = capsys.readouterr()
    assert "ffmpeg exited with code 2" in captured.err
    assert "MEDIA:" not in captured.out


def test_run_validation_failure_short_circuits(tmp_path, capsys):
    out = tmp_path / "out.mp4"
    rc = sv.run(_args(inputs=["only-one.mp4"], filename=str(out)))
    assert rc == 1
    captured = capsys.readouterr()
    assert "At least 2" in captured.err


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
