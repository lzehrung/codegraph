def helper_function():
    """A helper function."""
    return "Hello from utils"

class UtilityClass:
    """A utility class."""
    
    def __init__(self):
        self.value = 42
    
    def get_value(self):
        return self.value

def another_function():
    """Another function."""
    return "Another function"

# Export specific items
__all__ = ["helper_function", "UtilityClass"]