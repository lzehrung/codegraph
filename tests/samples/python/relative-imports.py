"""Scenario: relative imports should resolve to local modules."""
from .utils import helper_function as helper_alias
from .helpers import another_helper


def use_helpers():
    return helper_alias(), another_helper()
