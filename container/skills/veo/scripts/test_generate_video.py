# /// script
# requires-python = ">=3.10"
# dependencies = ["pytest>=8.0.0"]
# ///
"""Tests for generate_video.py argparse, validation, and mode selection."""

from __future__ import annotations

import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest import mock

import pytest

# Make the script importable without installing it.
HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

import generate_video as gv  # noqa: E402


def _args(**overrides) -> SimpleNamespace:
    base = dict(
        prompt="p",
        filename="out.mp4",
        input_images=None,
        last_frame=None,
        duration=8,
        resolution="720p",
        quality="fast",
        aspect_ratio="16:9",
        extend_from=None,
        long=False,
        api_key=None,
        poll_interval=0.0,
        max_poll_seconds=600.0,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


# --- validate_args -----------------------------------------------------------


def test_validate_accepts_text_to_video():
    ok, err = gv.validate_args(_args())
    assert ok and err is None


def test_validate_rejects_more_than_three_input_images(tmp_path):
    imgs = []
    for i in range(4):
        p = tmp_path / f"img{i}.png"
        p.write_bytes(b"\x89PNG")
        imgs.append(str(p))
    ok, err = gv.validate_args(_args(input_images=imgs))
    assert not ok
    assert "maximum is 3" in err


def test_validate_last_frame_requires_exactly_one_input_image(tmp_path):
    a, b, c = (tmp_path / n for n in ("a.png", "b.png", "c.png"))
    for p in (a, b, c):
        p.write_bytes(b"\x89PNG")
    ok, err = gv.validate_args(
        _args(input_images=[str(a), str(b)], last_frame=str(c))
    )
    assert not ok
    assert "exactly 1 --input-image" in err


def test_validate_extend_from_requires_long():
    ok, err = gv.validate_args(_args(extend_from="operations/x"))
    assert not ok
    assert "--long" in err


def test_validate_extend_from_with_long_ok():
    ok, err = gv.validate_args(_args(extend_from="operations/x", long=True))
    assert ok and err is None


def test_validate_lite_rejects_extend_from():
    ok, err = gv.validate_args(
        _args(quality="lite", extend_from="operations/x", long=True)
    )
    assert not ok
    assert "lite" in err


def test_validate_4k_requires_standard_quality():
    ok, err = gv.validate_args(_args(resolution="4k", quality="fast", duration=8))
    assert not ok
    assert "standard" in err


def test_validate_4k_requires_duration_8():
    ok, err = gv.validate_args(
        _args(resolution="4k", quality="standard", duration=6)
    )
    assert not ok
    assert "--duration 8" in err


def test_validate_missing_input_image_file():
    ok, err = gv.validate_args(_args(input_images=["/nonexistent/image.png"]))
    assert not ok
    assert "not found" in err


def test_validate_missing_last_frame_file(tmp_path):
    img = tmp_path / "a.png"
    img.write_bytes(b"\x89PNG")
    ok, err = gv.validate_args(
        _args(input_images=[str(img)], last_frame="/nonexistent/end.png")
    )
    assert not ok
    assert "Last-frame" in err


# --- quality → model mapping -------------------------------------------------


def test_quality_to_model_fast():
    assert gv.QUALITY_TO_MODEL["fast"] == "veo-3.1-fast-generate-preview"


def test_quality_to_model_standard():
    assert gv.QUALITY_TO_MODEL["standard"] == "veo-3.1-generate-preview"


def test_quality_to_model_lite():
    assert gv.QUALITY_TO_MODEL["lite"] == "veo-3.1-lite-generate-preview"


# --- get_api_key -------------------------------------------------------------


def test_api_key_from_arg_beats_env(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "env-key")
    assert gv.get_api_key("arg-key") == "arg-key"


def test_api_key_falls_back_to_env(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "env-key")
    assert gv.get_api_key(None) == "env-key"


def test_api_key_missing(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    assert gv.get_api_key(None) is None


# --- run() — no API key short-circuits ---------------------------------------


def test_run_exits_one_without_api_key(monkeypatch, capsys):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    rc = gv.run(_args())
    assert rc == 1
    captured = capsys.readouterr()
    assert "GEMINI_API_KEY" in captured.err


# --- run() — happy path (SDK mocked) -----------------------------------------


class _StubTypes:
    """Plain stub for `google.genai.types` that records constructor kwargs."""

    @staticmethod
    def Image(*, image_bytes, mime_type):
        return SimpleNamespace(image_bytes=image_bytes, mime_type=mime_type)

    @staticmethod
    def VideoGenerationReferenceImage(*, image, reference_type):
        return SimpleNamespace(image=image, reference_type=reference_type)

    @staticmethod
    def GenerateVideosConfig(**kwargs):
        return SimpleNamespace(**kwargs)


def _mock_genai_modules(monkeypatch, *, capture: dict) -> None:
    """Inject fake `google.genai` and `google.genai.types` modules.

    Records the kwargs passed to generate_videos in `capture`.
    """
    # The Veo operation: done immediately with a saveable video.
    saved_paths: list[str] = []

    class FakeVideo:
        def save(self, path):
            saved_paths.append(path)
            Path(path).write_bytes(b"FAKEMP4")

    operation = SimpleNamespace(
        name="operations/test-op",
        done=True,
        response=SimpleNamespace(
            generated_videos=[SimpleNamespace(video=FakeVideo())]
        ),
    )

    client = mock.MagicMock()
    client.models.generate_videos.side_effect = (
        lambda **kwargs: (capture.update(kwargs), operation)[1]
    )
    client.operations.get.return_value = operation

    # Use real ModuleType so `from google.genai import types` works.
    google_pkg = ModuleType("google")
    genai_mod = ModuleType("google.genai")
    types_mod = ModuleType("google.genai.types")

    genai_mod.Client = mock.MagicMock(return_value=client)
    types_mod.Image = _StubTypes.Image
    types_mod.VideoGenerationReferenceImage = _StubTypes.VideoGenerationReferenceImage
    types_mod.GenerateVideosConfig = _StubTypes.GenerateVideosConfig
    google_pkg.genai = genai_mod  # type: ignore[attr-defined]
    genai_mod.types = types_mod  # type: ignore[attr-defined]

    capture["_saved_paths"] = saved_paths
    capture["_client"] = client

    monkeypatch.setitem(sys.modules, "google", google_pkg)
    monkeypatch.setitem(sys.modules, "google.genai", genai_mod)
    monkeypatch.setitem(sys.modules, "google.genai.types", types_mod)


def test_run_text_to_video_emits_media_token(monkeypatch, capsys, tmp_path):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    capture: dict = {}
    _mock_genai_modules(monkeypatch, capture=capture)

    out = tmp_path / "rose.mp4"
    rc = gv.run(_args(filename=str(out)))
    assert rc == 0

    captured = capsys.readouterr()
    final_line = captured.out.strip().splitlines()[-1]
    assert final_line.startswith("MEDIA: ")
    assert final_line.endswith(str(out.resolve()))

    # The SDK was called without `image` or `video` kwargs (text-to-video).
    call_kwargs = {k: v for k, v in capture.items() if not k.startswith("_")}
    assert call_kwargs["model"] == "veo-3.1-fast-generate-preview"
    assert "image" not in call_kwargs
    assert "video" not in call_kwargs


def test_run_with_three_reference_images_passes_them_through(
    monkeypatch, capsys, tmp_path
):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    capture: dict = {}
    _mock_genai_modules(monkeypatch, capture=capture)

    imgs = []
    for i in range(3):
        p = tmp_path / f"ref{i}.png"
        p.write_bytes(b"\x89PNG\x00")
        imgs.append(str(p))

    out = tmp_path / "out.mp4"
    rc = gv.run(_args(filename=str(out), input_images=imgs))
    assert rc == 0

    # reference_images on config; no image= top-level.
    call_kwargs = {k: v for k, v in capture.items() if not k.startswith("_")}
    config = call_kwargs["config"]
    assert "image" not in call_kwargs
    assert len(config.reference_images) == 3
    for ref in config.reference_images:
        assert ref.reference_type == "asset"


def test_run_with_last_frame_uses_first_last_mode(monkeypatch, tmp_path):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    capture: dict = {}
    _mock_genai_modules(monkeypatch, capture=capture)

    first = tmp_path / "first.png"
    last = tmp_path / "last.png"
    for p in (first, last):
        p.write_bytes(b"\x89PNG\x00")

    out = tmp_path / "out.mp4"
    rc = gv.run(
        _args(filename=str(out), input_images=[str(first)], last_frame=str(last))
    )
    assert rc == 0

    call_kwargs = {k: v for k, v in capture.items() if not k.startswith("_")}
    assert "image" in call_kwargs  # first frame as top-level image=
    config = call_kwargs["config"]
    assert getattr(config, "last_frame", None) is not None
    assert not getattr(config, "reference_images", None)


def test_run_sdk_failure_surfaces_non_zero(monkeypatch, capsys):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    capture: dict = {}
    _mock_genai_modules(monkeypatch, capture=capture)
    capture["_client"].models.generate_videos.side_effect = RuntimeError("boom")

    rc = gv.run(_args())
    assert rc == 1
    captured = capsys.readouterr()
    assert "boom" in captured.err
    # No MEDIA token on failure.
    assert "MEDIA:" not in captured.out


def test_run_polling_emits_progress(monkeypatch, capsys, tmp_path):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    capture: dict = {}
    _mock_genai_modules(monkeypatch, capture=capture)

    client = capture["_client"]

    # First call returns a not-done operation; subsequent polls flip it to done.
    class FakeVideo:
        def save(self, path):
            Path(path).write_bytes(b"FAKEMP4")

    pending = SimpleNamespace(name="operations/p", done=False, response=None)
    completed = SimpleNamespace(
        name="operations/p",
        done=True,
        response=SimpleNamespace(generated_videos=[SimpleNamespace(video=FakeVideo())]),
    )
    client.models.generate_videos.side_effect = (
        lambda **kwargs: (capture.update(kwargs), pending)[1]
    )

    poll_results = [pending, completed]
    client.operations.get.side_effect = lambda *_: poll_results.pop(0)

    out = tmp_path / "out.mp4"
    rc = gv.run(_args(filename=str(out), poll_interval=0.0))
    assert rc == 0

    captured = capsys.readouterr()
    assert "Polling..." in captured.err


def test_run_aborts_when_max_poll_seconds_exceeded(monkeypatch, capsys, tmp_path):
    """A Veo operation that never completes within the cap exits 1 with a
    clear message naming the operation. Without this cap, the loop would
    spin until the container TTL killed it."""
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    capture: dict = {}
    _mock_genai_modules(monkeypatch, capture=capture)

    client = capture["_client"]

    # Operation that never finishes.
    pending = SimpleNamespace(name="operations/stuck", done=False, response=None)
    client.models.generate_videos.side_effect = (
        lambda **kwargs: (capture.update(kwargs), pending)[1]
    )
    client.operations.get.return_value = pending

    out = tmp_path / "out.mp4"
    # Poll interval 5s, cap 10s -> at most 2 poll iterations before the cap fires.
    rc = gv.run(
        _args(
            filename=str(out),
            poll_interval=5.0,
            max_poll_seconds=10.0,
        )
    )
    assert rc == 1

    captured = capsys.readouterr()
    assert "max-poll-seconds" in captured.err
    assert "operations/stuck" in captured.err
    assert "MEDIA:" not in captured.out


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
