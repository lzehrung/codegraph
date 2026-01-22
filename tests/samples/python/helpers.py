import json

def helper_function():
    """Helper function from helpers module."""
    return "Helper function from helpers module"

def another_helper():
    """Another helper function."""
    return json.loads("123")

class HelperInterface:
    """A helper interface class."""
    
    def __init__(self, name, value):
        self.name = name
        self.value = value
