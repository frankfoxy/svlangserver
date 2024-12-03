#
SCRIPT_DIR := $(patsubst %/,%,$(dir $(realpath $(firstword $(MAKEFILE_LIST)))))

INSTALL_DIR := /mnt/c/Users/frankfoxy/.vscode/extensions/imctradingbv.svlangserver-0.4.1/dist/

export PATH:=/mnt/f/EDA/nodejs/:$(PATH)
export NODE_OPTIONS:=--openssl-legacy-provider

all: build install

build:
	@npm run webpack

install:
	@echo " * install dist to $(INSTALL_DIR) ..."
	@/bin/cp -a -f $(SCRIPT_DIR)/dist/*.js $(INSTALL_DIR)/

