#!/usr/bin/env bash
cd /d/Projects/job-hunter
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY
GIT_TERMINAL_PROMPT=0 git -c http.proxy= -c https.proxy= push -u origin main 2>&1
