#!/usr/bin/env node

import commandLineArgs from 'command-line-args';

import { createServer } from './server.js';

const optionDefinitions = [
  { name: 'config', alias: 'c', type: String, defaultValue: null },
  { name: 'sortWords', type: Boolean, defaultValue: false },
  { name: 'stdio', type: String },
  { name: 'engine', type: String, defaultValue: null },
];

const options = commandLineArgs(optionDefinitions);

const server = createServer({
  config: options.config,
  engine: options.engine,
  sortWords: options.sortWords,
});

server.listen();
