def bind_match(p):
    match p:
        case (x, y):
            return x + y
        case v as w:
            return w
