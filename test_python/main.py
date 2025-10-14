from .utils import helper_function, UtilityClass

def main():
    # Test go-to-definition on imported function
    result = helper_function()
    print(result)
    
    # Test go-to-definition on imported class
    util = UtilityClass()
    value = util.get_value()
    print(f"Value: {value}")

if __name__ == "__main__":
    main()

