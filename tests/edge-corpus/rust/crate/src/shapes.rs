// @def Circle @coverage Circle partial
pub struct Circle {
    pub radius: f64, // @def circleRadius=radius
}

// @def Square
pub struct Square {
    pub side: f64,
}

// @def Derived
pub struct Derived;

// @def Disk
pub struct Disk {
    pub radius: f64,
}

impl Circle {
    // @def circleNew=new
    pub fn new(
        radius: f64,
    ) -> Self {
        Circle { radius }
    }

    // @def circleArea=area
    pub fn area(
        &self,
    ) -> f64 {
        self.radius * self.radius
    }

    pub fn scaled(&self) -> f64 {
        self.area() // @ref circleArea
    }
}

impl Square {
    // @def squareArea=area
    pub fn area(
        &self,
    ) -> f64 {
        self.side * self.side
    }
}

// @def Shape
pub trait Shape {
    // @def shapeArea=area
    fn area(
        &self,
    ) -> f64 {
        0.0
    }
}

// Derived keeps the trait's default method.
impl Shape for Derived {}

impl Shape for Disk {
    // @def diskArea=area
    fn area(
        &self,
    ) -> f64 {
        self.radius * self.radius
    }
}
