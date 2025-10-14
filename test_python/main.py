from .utils import helper_function, UtilityClass
import .utils as utils

def main():
    # Test go-to-definition on imported function
    result = helper_function()
    print(result)
    
    # Test go-to-definition on imported class
    util = UtilityClass()
    value = util.get_value()
    print(f"Value: {value}")
    
    # Test namespace import navigation
    utils_result = utils.helper_function()
    print(f"Utils result: {utils_result}")
    
    # Test namespace class navigation
    utils_class = utils.UtilityClass()
    utils_value = utils_class.get_value()
    print(f"Utils value: {utils_value}")

if __name__ == "__main__":
    main()