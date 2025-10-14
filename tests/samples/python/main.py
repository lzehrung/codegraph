from .utils import helper_function, UtilityClass, CONSTANT_VALUE
from . import utils
from .utils import helper_function as helper_alias
from .helpers import another_helper

# Namespace import usage
utils_result = utils.helper_function()
utils_class = utils.UtilityClass(100)

# Direct import usage
result = helper_function()
util = UtilityClass(50)
value = util.get_value()

# Alias usage
alias_result = helper_alias()

# Another helper usage
helper_value = another_helper()

# Constant usage
print(CONSTANT_VALUE)

def main():
    """Main function."""
    print(result)
    print(value)
    print(utils_result)
    print(alias_result)
    print(helper_value)

if __name__ == "__main__":
    main()
