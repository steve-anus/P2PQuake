#!/usr/bin/env python3
"""Embed Metal source so the executable works without external shader files."""
import json
from pathlib import Path
import sys

Path(sys.argv[2]).write_text('static const char qnm_shader_source[] =\n' +
    '\n'.join(json.dumps(line) for line in Path(sys.argv[1]).read_text().splitlines(True)) + ';\n')
