package main

func rangeValues(xs []int) int {
	total := 0
	for i, v := range xs {
		total += i + v
	}
	for _, v := range xs {
		total += v
	}
	return total
}
