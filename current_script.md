 4) 실사 검색 — type=real만 (영문 키워드 3개, 클릭 시 구글 이미지 검색)
            const realScenes = scenes.filter(s => s.type === 'real');
            const _getKeywords = (s) => {
                // 신규: real_keywords 배열, 구버전: real_keyword 문자열 폴백
                if (Array.isArray(s.real_keywords) && s.real_keywords.length > 0) return s.real_keywords;
                if (typeof s.real_keyword === 'string' && s.real_keyword.trim()) return [s.real_keyword.trim()];
                return [];
            };
            // 텍스트 영역용 (복사용)
            const realLines = realScenes
                .map(s => {
                    const kws = _getKeywords(s);
                    const kwLines = kws.length > 0
                        ? kws.map((k, i) => `  ${i+1}. ${k}\n     https://www.google.com/search?tbm=isch&q=${encodeURIComponent(k)}`).join('\n')
                        : '  (검색어 없음)';
                    const aiBackup = s.nano_prompt ? `\n  [AI 백업] nano_prompt:\n  ${s.nano_prompt}\n  grok_prompt:\n  ${s.grok_prompt || '(없음)'}` : '';
                    return `[장면 ${s.sceneNo}] ${s.real_subject || ''}\n${kwLines}${aiBackup}\n`;
                })
                .join('\n');
            document.getElementById('spOut_real').value = realLines || '(실사 장면 없음)';
            _spSetCountLabel('spOut_real', `📷 총 ${realScenes.length}개 실사 검색`);
            // 클릭 가능 링크 영역
            const linksEl = document.getElementById('spOut_realLinks');
            if (linksEl) {
                if (realScenes.length === 0) {
                    linksEl.innerHTML = '<div style="color:#