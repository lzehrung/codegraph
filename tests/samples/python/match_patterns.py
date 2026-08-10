class Point:
    def __init__(self, x, y):
        self.x = x
        self.y = y


def describe(p):
    match p:
        case Point(x=px, y=py):
            return px + py
        case _:
            return 0
