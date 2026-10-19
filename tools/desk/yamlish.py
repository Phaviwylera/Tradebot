"""A tiny YAML-subset reader used only when PyYAML is not installed.

`config.yaml` deliberately stays inside this subset: comments, nested mappings and scalar
values (strings, booleans, integers, floats, null). No lists, anchors, multi-line strings or
flow collections. That makes the desk runnable on a bare Python install, which matters for a
project whose first instruction is "run it and read the reports".

If real YAML features ever appear in config.yaml, install PyYAML: the real parser is preferred
whenever it is importable, and a test asserts both readers agree on the shipped file.
"""

from __future__ import annotations

from typing import Any


class YamlSubsetError(ValueError):
    """Raised when a line falls outside the supported subset."""


def _strip_comment(line: str) -> str:
    quote = ""
    for index, char in enumerate(line):
        if quote:
            if char == quote:
                quote = ""
            continue
        if char in ("'", '"'):
            quote = char
            continue
        if char == "#" and (index == 0 or line[index - 1] in " \t"):
            return line[:index]
    return line


def _scalar(text: str) -> Any:
    value = text.strip()
    if value == "":
        return None
    lowered = value.lower()
    if lowered in ("true", "yes", "on"):
        return True
    if lowered in ("false", "no", "off"):
        return False
    if lowered in ("null", "~", "none"):
        return None
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    try:
        return int(value)
    except ValueError:
        pass
    try:
        return float(value)
    except ValueError:
        pass
    return value


def safe_load(text: str) -> dict[str, Any]:
    """Parse the supported subset into nested dicts. Raises YamlSubsetError on anything else."""
    root: dict[str, Any] = {}
    stack: list[tuple[int, dict[str, Any]]] = [(-1, root)]

    for number, raw in enumerate(text.splitlines(), start=1):
        line = _strip_comment(raw).rstrip()
        if not line.strip():
            continue
        stripped = line.lstrip(" ")
        indent = len(line) - len(stripped)
        if "\t" in line[:indent] or stripped.startswith("\t"):
            raise YamlSubsetError(f"line {number}: tabs are not supported, use spaces")
        if stripped.startswith("- "):
            raise YamlSubsetError(f"line {number}: lists are not supported in config.yaml")
        key, separator, value = stripped.partition(":")
        if not separator or not key.strip():
            raise YamlSubsetError(f"line {number}: expected 'key: value'")

        while stack and indent <= stack[-1][0]:
            stack.pop()
        if not stack:
            raise YamlSubsetError(f"line {number}: bad indentation")
        parent = stack[-1][1]

        if value.strip() == "":
            child: dict[str, Any] = {}
            parent[key.strip()] = child
            stack.append((indent, child))
        else:
            parent[key.strip()] = _scalar(value)

    return root
