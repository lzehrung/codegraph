# Task: Python in the Monorepo

## Goal
Ensure Python packages inside the monorepo are indexed and intra-package navigation works.

## Requirements
- Use `tests/samples/monorepo/packages/py-app`.
- Verify go-to-definition within the Python package (`helper_function`, `Utility`).
- Optional stretch: add a second Python package and test cross-package imports.

## Expected Examples
- From `py-app/main.py`, goto on `Utility` goes to `py-app/utils.py`.
- References for `helper_function` include `__init__.py` exports and `main.py` usages.

## Edge Cases
- Relative imports (`from . import utils`) and `__all__` handling.

## Deliverables
- Tests under a new `tests/python-workspace.test.ts` or expanded `workspace.test.ts`.
