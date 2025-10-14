def helper_function():
    """A helper function."""
    return "Hello from utils"

class UtilityClass:
    """A utility class."""
    
    def __init__(self, value=42):
        self.value = value
    
    def get_value(self):
        return self.value
    
    def set_value(self, value):
        self.value = value

CONSTANT_VALUE = "constant"

class UtilityType:
    """A utility type class."""
    
    def __init__(self, id_val, name):
        self.id = id_val
        self.name = name

# Export specific items
__all__ = ["helper_function", "UtilityClass", "CONSTANT_VALUE"]

# Re-export from helpers
from .helpers import helper_function as re_exported_helper
