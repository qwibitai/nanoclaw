MAIN = main

.PHONY: all clean watch wc

all:
	latexmk -pdf $(MAIN)

watch:
	latexmk -pdf -pvc $(MAIN)

clean:
	latexmk -C

open: all
	open $(MAIN).pdf

wc:
	@detex $(MAIN).tex | wc -w
