"""Module docstring explaining the purpose of this file."""

import os
from pathlib import Path

CONFIG_PATH = Path("config.yml")

class Foo:
  """Class docstring for Foo."""

  def method(self, x):
    """Method docstring."""
    if x > 0:
      return x
    return -x


def top_level(y):
  """Top-level function docstring."""
  for i in range(y):
    print(i)

