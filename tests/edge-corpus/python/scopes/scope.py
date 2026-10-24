# @def module_value @coverage module_value complete
module_value = 0

# @def track
def track(function):
    return function

class Counter:
    count = 0  # @def classCount @coverage classCount complete

    def __init__(self):
        self.count = 0  # @def instanceCount

    def add(self, amount):
        Counter.count += amount  # @ref classCount @goto classCount
        self.count += amount  # @ref instanceCount
        return self.count  # @goto instanceCount

# @def outer
def outer(
    *args,  # @def args
    **kwargs,  # @def kwargs
):
    total = 0  # @def total @coverage total complete

    def inner(delta):  # @def inner
        nonlocal total  # @ref total
        global module_value
        total += delta  # @ref total
        module_value += 1  # @ref module_value
        return f"{total}:{args}:{kwargs}"  # @ref total @ref args @ref kwargs

    return inner  # @ref inner @goto inner

@track  # @ref track @goto track
def decorated():
    return outer(1, flag=True)  # @ref outer @goto outer

class Service:
    # @def run
    def run(self):
        return 1

def via_annotated():
    svc: Service = Service()
    return svc.run()  # @ref run @goto run
