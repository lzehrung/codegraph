use crate::shapes::Circle;

pub fn malformed(circle: Circle) -> f64 {
    let reference = circle.radius + ; // @ref circleRadius @known-gap parse_error_field_reference observed=none
    circle.radius + ; // @goto circleRadius=radius @known-gap parse_error_field_goto observed=not_found
    reference
