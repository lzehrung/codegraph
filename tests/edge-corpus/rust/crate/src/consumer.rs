use crate::api::{renamed_add, Ring};
use crate::calc::*; /* square */ // @not-ref square
use crate::nested::child::{self, from_child};
use crate::shapes::{Circle, Derived, Disk, Shape, Square};

pub fn reexported() -> i32 {
    let _ring = Ring::new(1.0);
    let _child = child::from_child();
    let _ = from_child();
    let aliased = renamed_add(1, 2); // @goto add=renamed_add @known-gap reexport_alias_call_not_resolved observed=not_found
    aliased + _child
}

pub fn globbed(value: f64) -> f64 {
    square(value) // @ref square @goto square @not-ref decoySquare
}

pub fn associated_vs_method() -> f64 {
    let built = Circle::new(1.0); // @ref circleNew @goto circleNew
    let inherent = Circle { radius: 2.0 }.area(); // @ref circleArea @not-ref squareArea
    let defaulted = Derived;
    let default_area = defaulted.area(); // @ref shapeArea @goto shapeArea
    let overridden = Disk { radius: 3.0 }.area(); // @ref diskArea @not-ref shapeArea
    let other = Square { side: 4.0 }.area(); // @not-ref circleArea
    let _ = built.radius;
    inherent + default_area + overridden + other
}
