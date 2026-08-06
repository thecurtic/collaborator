"""_parse_tool_args: malformed streamed tool arguments must never silently
become {} — for tools with a valid no-args mode (transcribe_video lists
stored transcripts) that turns a parse failure into a healthy-looking wrong
result the model retries forever."""
from inference import _parse_tool_args


def test_valid_object():
    args, err = _parse_tool_args('{"url": "https://x.test/v", "chunk": 2}')
    assert err is None
    assert args == {"url": "https://x.test/v", "chunk": 2}


def test_empty_and_whitespace_mean_no_args():
    assert _parse_tool_args("") == ({}, None)
    assert _parse_tool_args("   \n") == ({}, None)
    assert _parse_tool_args(None) == ({}, None)


def test_duplicated_final_delta_is_salvaged():
    # Provider re-sent the final delta: '{...}{...}' — take the first object.
    raw = '{"url": "https://x.test/v"}{"url": "https://x.test/v"}'
    args, err = _parse_tool_args(raw)
    assert err is None
    assert args == {"url": "https://x.test/v"}


def test_trailing_garbage_is_salvaged():
    args, err = _parse_tool_args('{"query": "heat pumps"} and then some')
    assert err is None
    assert args == {"query": "heat pumps"}


def test_garbage_reports_error_not_empty_args():
    args, err = _parse_tool_args('url = youtube.com/watch?v=abc')
    assert args is None
    assert "not valid JSON" in err


def test_non_object_json_reports_error():
    args, err = _parse_tool_args('["https://x.test/v"]')
    assert args is None
    assert "JSON object" in err
