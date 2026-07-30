#!/bin/bash
cd /home/ubuntu/projects/charon
exec node index.js >> charon.log 2>&1
