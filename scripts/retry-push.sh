#!/usr/bin/env bash
# 后台轮询网络，恢复即推送 c9c21b9
cd /d/Projects/job-hunter
for i in $(seq 1 60); do
  code=$(curl --noproxy "*" -s -o /dev/null -w "%{http_code}" --connect-timeout 8 https://github.com 2>/dev/null)
  echo "[$(date +%H:%M:%S)] github=$code (#$i/60)"
  if [ "$code" = "200" ]; then
    echo "network recovered, pushing..."
    unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY
    if GIT_TERMINAL_PROMPT=0 git -c http.proxy= -c https.proxy= push -u origin main 2>&1; then
      echo "PUSH_OK"
      exit 0
    fi
    echo "push failed, retrying..."
  fi
  sleep 15
done
echo "timeout 15min"
exit 1
