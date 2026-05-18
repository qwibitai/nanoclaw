# /// script
# requires-python = ">=3.10"
# dependencies = ["pytest>=8.0.0"]
# ///
"""Tests for extract_frame.py."""

from __future__ import annotations

import stat
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

import extract_frame as ef  # noqa: E402


def _args(**overrides) -> SimpleNamespace:
    base = dict(
        input="ref.mp4",
        filename="out.png",
        mode="first",
        timestamp=None,
        ffmpeg="ffmpeg",
        ffprobe="ffprobe",
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def _touch(path: Path, data: bytes = b"x") -> str:
    path.write_bytes(data)
    return str(path)


# --- validate_args -----------------------------------------------------------


def test_validate_rejects_missing_input(tmp_path):
    ok, err = ef.validate_args(_args(input=str(tmp_path / "missing.mp4")))
    assert not ok
    assert "Input not found" in err


def test_validate_timestamp_mode_requires_timestamp(tmp_path):
    inp = _touch(tmp_path / "ref.mp4")
    ok, err = ef.validate_args(_args(input=inp, mode="timestamp", timestamp=None))
    assert not ok
    assert "--timestamp" in err


def test_validate_negative_timestamp_rejected(tmp_path):
    inp = _touch(tmp_path / "ref.mp4")
    ok, err = ef.validate_args(
        _args(input=inp, mode="timestamp", timestamp=-0.1)
    )
    assert not ok
    assert ">=" in err


def test_validate_happy_paths(tmp_path):
    inp = _touch(tmp_path / "ref.mp4")
    for mode in ("first", "last"):
        ok, err = ef.validate_args(_args(input=inp, mode=mode))
        assert ok and err is None, (mode, err)
    ok, err = ef.validate_args(_args(input=inp, mode="timestamp", timestamp=1.0))
    assert ok and err is None


# --- build_command -----------------------------------------------------------


def test_build_command_first_frame(tmp_path):
    inp = _touch(tmp_path / "ref.mp4")
    args = _args(input=inp, mode="first")
    cmd = ef.build_command(args, Path("out.png"))
    assert "-frames:v" in cmd and cmd[cmd.index("-frames:v") + 1] == "1"
    assert "-sseof" not in cmd


def test_build_command_last_frame_uses_sseof(tmp_path):
    inp = _touch(tmp_path / "ref.mp4")
    args = _args(input=inp, mode="last")
    cmd = ef.build_command(args, Path("out.png"))
    assert "-sseof" in cmd


def test_build_command_timestamp_uses_ss(tmp_path):
    inp = _touch(tmp_path / "ref.mp4")
    args = _args(input=inp, mode="timestamp", timestamp=2.5)
    cmd = ef.build_command(args, Path("out.png"))
    assert "-ss" in cmd
    assert "2.5" in cmd


# --- run() end-to-end with stubbed ffmpeg / ffprobe --------------------------


def _install_fake_ffmpeg(tmp_path: Path, *, exit_code: int = 0) -> str:
    """Stub uses /bin/bash explicitly because ${@: -1} is a bashism that
    errors under dash (default /bin/sh on Debian/Ubuntu)."""
    stub = tmp_path / "fake-ffmpeg"
    stub.write_text(
        "#!/bin/bash\n"
        f"if [ {exit_code} -eq 0 ]; then\n"
        '  out="${@: -1}"\n'
        "  echo FAKEPNG > \"$out\"\n"
        "fi\n"
        f"exit {exit_code}\n"
    )
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return str(stub)


def _install_fake_ffprobe(tmp_path: Path, *, duration: float | None) -> str:
    stub = tmp_path / "fake-ffprobe"
    if duration is None:
        stub.write_text("#!/bin/bash\nexit 1\n")
    else:
        stub.write_text(f"#!/bin/bash\necho {duration}\nexit 0\n")
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return str(stub)


def test_run_first_frame_happy_path(tmp_path, capsys):
    inp = _touch(tmp_path / "ref.mp4")
    out = tmp_path / "frame.png"
    fake_ff = _install_fake_ffmpeg(tmp_path, exit_code=0)
    fake_probe = _install_fake_ffprobe(tmp_path, duration=2.0)

    rc = ef.run(_args(input=inp, filename=str(out), mode="first", ffmpeg=fake_ff, ffprobe=fake_probe))
    assert rc == 0
    assert out.exists()

    final_line = capsys.readouterr().out.strip().splitlines()[-1]
    assert final_line.startswith("FRAME: ")
    assert final_line.endswith(str(out.resolve()))


def test_run_timestamp_within_range(tmp_path, capsys):
    inp = _touch(tmp_path / "ref.mp4")
    out = tmp_path / "frame.png"
    fake_ff = _install_fake_ffmpeg(tmp_path, exit_code=0)
    fake_probe = _install_fake_ffprobe(tmp_path, duration=5.0)

    rc = ef.run(
        _args(
            input=inp,
            filename=str(out),
            mode="timestamp",
            timestamp=2.0,
            ffmpeg=fake_ff,
            ffprobe=fake_probe,
        )
    )
    assert rc == 0


def test_run_timestamp_out_of_range_rejected(tmp_path, capsys):
    inp = _touch(tmp_path / "ref.mp4")
    out = tmp_path / "frame.png"
    fake_ff = _install_fake_ffmpeg(tmp_path, exit_code=0)
    fake_probe = _install_fake_ffprobe(tmp_path, duration=2.0)

    rc = ef.run(
        _args(
            input=inp,
            filename=str(out),
            mode="timestamp",
            timestamp=10.0,
            ffmpeg=fake_ff,
            ffprobe=fake_probe,
        )
    )
    assert rc == 1
    captured = capsys.readouterr()
    assert "exceeds input duration" in captured.err
    assert "FRAME:" not in captured.out


def test_run_ffmpeg_failure_propagates(tmp_path, capsys):
    inp = _touch(tmp_path / "ref.mp4")
    out = tmp_path / "frame.png"
    fake_ff = _install_fake_ffmpeg(tmp_path, exit_code=3)
    fake_probe = _install_fake_ffprobe(tmp_path, duration=2.0)

    rc = ef.run(_args(input=inp, filename=str(out), mode="first", ffmpeg=fake_ff, ffprobe=fake_probe))
    assert rc == 1
    captured = capsys.readouterr()
    assert "exited with code 3" in captured.err


def test_run_skips_range_check_when_ffprobe_fails(tmp_path):
    """If ffprobe can't determine duration, we proceed and let ffmpeg decide."""
    inp = _touch(tmp_path / "ref.mp4")
    out = tmp_path / "frame.png"
    fake_ff = _install_fake_ffmpeg(tmp_path, exit_code=0)
    fake_probe = _install_fake_ffprobe(tmp_path, duration=None)  # fails

    rc = ef.run(
        _args(
            input=inp,
            filename=str(out),
            mode="timestamp",
            timestamp=99.0,
            ffmpeg=fake_ff,
            ffprobe=fake_probe,
        )
    )
    # No range error, so we attempt the extraction. Stub returns 0, so success.
    assert rc == 0


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
