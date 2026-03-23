package main

type Runner interface {
	Run() string
}

type Service[T any] struct {
	Value T
}

func BuildService[T any](value T) Service[T] {
	return Service[T]{Value: value}
}
