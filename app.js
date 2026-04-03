$(document).ready(function() {
    let topics = {};
    $.getJSON('topics.json', function(data) { topics = data; });

    let activeSteps = [];
    let sessionTotalTime = 0;

    function buildActiveSteps() {
        const fw = $('.framework-check:checked').val();
        if (!fw || !frameworks[fw]) { activeSteps = []; sessionTotalTime = 0; return; }
        sessionTotalTime = timeLeft;
        let cum = 0;
        activeSteps = frameworks[fw].steps.map(step => {
            cum += step.weight;
            return { label: step.label, hint: step.hint, endFraction: cum };
        });
    }

    function updateStepDisplay() {
        if (!activeSteps.length || !sessionTotalTime) { $('#step-display').empty(); return; }
        const elapsed = sessionTotalTime - timeLeft;
        const fraction = elapsed / sessionTotalTime;
        const step = activeSteps.find(s => fraction < s.endFraction) || activeSteps[activeSteps.length - 1];
        $('#step-display').html(`<span class="step-label">${step.label}</span> · ${step.hint}`);
    }

    function clearStepDisplay() {
        activeSteps = [];
        sessionTotalTime = 0;
        $('#step-display').empty();
    }

    let frameworks = {};
    $.getJSON('framework.json', function(data) {
        frameworks = data;
        updateFrameworkOptions($('.goal-check:checked').val());
    });

    function updateFrameworkOptions(goal) {
        const options = Object.keys(frameworks).filter(name => frameworks[name].goals.includes(goal));
        const $menu = $('#menu-framework');
        $menu.empty();
        const saved = (() => { try { return JSON.parse(localStorage.getItem('speechSessionFilters') || '{}').framework?.[0]; } catch(e) { return null; } })();
        let defaultIndex = options.indexOf(saved);
        if (defaultIndex === -1) defaultIndex = 0;
        options.forEach((fw, i) => {
            const checked = i === defaultIndex ? 'checked' : '';
            const activeClass = i === defaultIndex ? 'active-text' : '';
            $menu.append(`<label class="choice-option ${activeClass}"><input type="radio" class="framework-check" name="framework" value="${fw}" ${checked}> ${fw}</label>`);
        });
        $('#framework-section').toggle(options.length > 0);
        $('#val-framework').text(options.length > 0 ? options[defaultIndex] : '—');
        saveFilters();
    }

    let savedTime = parseInt(localStorage.getItem('speechSessionTimer')) || 60;
    let timeLeft = savedTime;
    let timer = null;
    let winTimeout = null;
    let isRunning = false;
    let topicSelected = false;

    // Recording state
    let recordingEnabled = false;
    let mediaRecorder = null;
    let recordedChunks = [];
    let audioBlob = null;
    let recObjectUrl = null;
    let micStream = null;

    // Speech detection state
    const speechApiSupported = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    let speechRecognition = null;
    let speechDetected = false;

    // Session metadata for export
    let sessionDuration = 0;
    let sessionDate = null;

    // Energy sampling state
    let audioContext = null;
    let analyser = null;
    let energySamples = [];
    let sampleInterval = null;

    // Mobile Bottom Sheet Logic
    function openSheet() {
        renderSheet();
        $('#sheet-overlay').addClass('open');
        $('#bottom-sheet').addClass('open');
    }

    function closeSheet() {
        $('#sheet-overlay').removeClass('open');
        $('#bottom-sheet').removeClass('open');
    }

    function renderSheet() {
        const types = [
            { key: 'diff', id: 'sheet-opts-diff', checkClass: 'diff-check', single: true },
            { key: 'cat', id: 'sheet-opts-cat', checkClass: 'cat-check', single: false },
            { key: 'goal', id: 'sheet-opts-goal', checkClass: 'goal-check', single: true },
            { key: 'framework', id: 'sheet-opts-framework', checkClass: 'framework-check', single: true }
        ];
        $('#sheet-group-framework').toggle($('.framework-check').length > 0);

        types.forEach(type => {
            const $container = $(`#${type.id}`);
            $container.empty();

            $(`.${type.checkClass}`).each(function() {
                const value = $(this).val();
                const label = $(this).parent().text().trim();
                const isChecked = $(this).prop('checked');

                const $opt = $(`<div class="sheet-option ${isChecked ? 'selected' : ''}">${label}</div>`);

                $opt.click(function() {
                    const $check = $(`.${type.checkClass}[value="${value}"]`);
                    if (type.single) {
                        $(`.${type.checkClass}`).prop('checked', false);
                        $check.prop('checked', true).trigger('change');
                    } else {
                        $check.prop('checked', !$check.prop('checked')).trigger('change');
                    }
                    renderSheet();
                });
                $container.append($opt);
            });

            const noneChecked = $(`.${type.checkClass}:checked`).length === 0;
            $(`#sheet-warn-${type.key}`).toggle(noneChecked);
        });
    }

    $('#open-sheet').click(openSheet);
    $('#sheet-overlay').click(closeSheet);

    function updateMobileFilterDisplay() {
        const diffLabel = $('#val-diff').text();
        const catLabel = $('#val-cat').text();
        const goalLabel = $('#val-goal').text();
        $('#mobile-filter-display').html(`
            <span class="filter-meta-group"><i data-lucide="graduation-cap"></i> ${diffLabel}</span>
            <span class="filter-meta-group"><i data-lucide="tag"></i> ${catLabel}</span>
            <span class="filter-meta-group"><i data-lucide="crosshair"></i> ${goalLabel}</span>
        `);
        lucide.createIcons();
    }

    // Close sidebar on navigation (mobile) - updated for sheet if needed, 
    // but resources link is in header now.
    $('.resources-link').click(function() {
        closeSheet();
    });

    // Accordion Logic
    $('.choice-trigger').click(function() {
        const $menu = $(this).next('.choice-menu');
        const $trigger = $(this);
        $('.choice-menu').not($menu).removeClass('open');
        $('.choice-trigger').not($trigger).removeClass('active');
        $menu.toggleClass('open');
        $trigger.toggleClass('active');
    });

    function saveFilters() {
        const selectedFilters = {
            diff: $('.diff-check:checked').map(function() { return this.value; }).get(),
            cat: $('.cat-check:checked').map(function() { return this.value; }).get(),
            goal: $('.goal-check:checked').map(function() { return this.value; }).get(),
            framework: $('.framework-check:checked').map(function() { return this.value; }).get()
        };
        localStorage.setItem('speechSessionFilters', JSON.stringify(selectedFilters));
    }

    // Framework change handler
    $(document).on('change', '.framework-check', function() {
        $('#val-framework').text($(this).val());
        saveFilters();
    });

    // Multi-Select Label Updates
    $('.diff-check, .cat-check, .goal-check').change(function() {
        const type = $(this).hasClass('diff-check') ? 'diff' : ($(this).hasClass('cat-check') ? 'cat' : 'goal');
        const checked = $(`.${type}-check:checked`);
        const isSingle = $(`.${type}-check`).first().is('[type="radio"]');
        let label = isSingle
            ? (checked.length === 0 ? 'None' : checked.first().parent().text().trim())
            : (checked.length === 3 ? 'All' : (checked.length === 0 ? 'None' : checked.map(function() { return $(this).parent().text().trim(); }).get().join(", ")));
        $(`#val-${type}`).text(label);
        $(`#warn-${type}`).toggle(checked.length === 0);

        if (type === 'goal') updateFrameworkOptions(checked.val());

        // Sync mobile display after labels are updated
        updateMobileFilterDisplay();

        saveFilters();

        // Auto-reload topic on filter change if not currently speaking
        if (!isRunning) {
            getNewTopic(true);
            $('#btn-main').text('Start Speaking');
        }
    });

    function loadFilters() {
        const saved = localStorage.getItem('speechSessionFilters');
        if (!saved) return;
        try {
            const filters = JSON.parse(saved);
            
            // Reset all to unchecked first
            $('.diff-check, .cat-check, .goal-check').prop('checked', false);
            
            // Apply saved states
            if (filters.diff) filters.diff.forEach(v => $(`.diff-check[value="${v}"]`).prop('checked', true));
            if (filters.cat) filters.cat.forEach(v => $(`.cat-check[value="${v}"]`).prop('checked', true));
            if (filters.goal) filters.goal.forEach(v => $(`.goal-check[value="${v}"]`).prop('checked', true));
            
            // Trigger label updates
            ['diff', 'cat', 'goal'].forEach(type => {
                const checked = $(`.${type}-check:checked`);
                const isSingle = $(`.${type}-check`).first().is('[type="radio"]');
                let label = isSingle
                    ? (checked.length === 0 ? 'None' : checked.first().parent().text().trim())
                    : (checked.length === 3 ? 'All' : (checked.length === 0 ? 'None' : checked.map(function() { return $(this).parent().text().trim(); }).get().join(", ")));
                $(`#val-${type}`).text(label);
            });
        } catch (e) { console.error("Error loading filters", e); }
    }

    function updateDisplay(snap = false) {
        let mins = Math.floor(timeLeft / 60);
        let secs = timeLeft % 60;
        $('#timer-display').text(`${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`);
        
        // Update Orbital Arch
        const initialTime = parseInt(localStorage.getItem('speechSessionTimer')) || 60;
        
        // Refined progress calculation to prevent early completion
        const progress = timeLeft / initialTime;
        const offset = 283 - (progress * 283);
        
        const $bar = $('.timer-bar');
        if (snap) {
            $bar.addClass('no-transition');
            $bar.css('stroke-dashoffset', 0); // Reset to full
            $bar[0].offsetHeight; 
            $bar.removeClass('no-transition');
        } else {
            $bar.css('stroke-dashoffset', offset);
        }

        if (timeLeft < 15 && timeLeft > 0) $('#timer-display').addClass('warning');
        else $('#timer-display').removeClass('warning');

        updateStepDisplay();
    }

    $('#time-plus').click(function() {
        if (timeLeft < 1800) {
            timeLeft += 10;
            localStorage.setItem('speechSessionTimer', timeLeft);
            updateDisplay(true); // snap=true to keep circle full
        }
    });
    $('#time-minus').click(function() { 
        if (timeLeft > 10) {
            timeLeft -= 10;
            localStorage.setItem('speechSessionTimer', timeLeft); 
            updateDisplay(true); // snap=true to keep circle full
        } 
    });

    function getNewTopic(isWelcome = false) {
        const $text = $('#topic-text');
        const diffs = $('.diff-check:checked').map(function() { return this.value; }).get();
        const cats = $('.cat-check:checked').map(function() { return this.value; }).get();
        const goals = $('.goal-check:checked').map(function() { return this.value; }).get();
        let pool = [];
        diffs.forEach(d => { if(topics[d]) pool = pool.concat(topics[d]); });
        let filteredTopics = pool.filter(t => cats.includes(t.category) && goals.includes(t.goal));
        
        if (filteredTopics.length === 0) { 
            $text.html("No matches."); 
            topicSelected = false; 
            return false; 
        }
        
        const finalTopic = filteredTopics[Math.floor(Math.random() * filteredTopics.length)].text;
        topicSelected = true;
        
        if (isWelcome) {
            $text.html(finalTopic).addClass('welcome-beat');
            setTimeout(() => $text.removeClass('welcome-beat'), 1200);
        } else {
            $text.css({opacity: 0, filter: 'blur(10px)', color: 'var(--text)'});
            setTimeout(() => { $text.html(finalTopic).css({opacity: 1, filter: 'blur(0)'}); }, 400);
        }
        return true;
    }

    // Initial Load
    loadFilters();

    $.getJSON('topics.json', function(data) { 
        topics = data; 
        getNewTopic(true);
        topicSelected = true;
    });

    $('#btn-reroll').click(function() {
        const $btn = $(this);
        $btn.addClass('spinning');
        setTimeout(() => $btn.removeClass('spinning'), 600);
        
        getNewTopic();
        $('#btn-main').text('Start Speaking');
    });

    $('#btn-main').click(function() {
        const $btn = $(this);

        // State 1: IDLE / READY -> Start Speaking
        if (!isRunning && ($btn.text() === 'Start Speaking')) {
            if (winTimeout) { clearTimeout(winTimeout); winTimeout = null; }
            $('.canvas').removeClass('bloom');
            buildActiveSteps();
            updateStepDisplay();

            $btn.text('Pause');
            $('#btn-reroll').removeClass('active');
            $('#timer-display').addClass('active');
            $('.time-adjust').prop('disabled', true);
            $('#time-plus, #time-minus').addClass('hidden');
            $('#btn-reset-icon').addClass('active').prop('disabled', false);
            
            if (recordingEnabled) {
                startRecording();
                $('#record-toggle span:last-child').text('Recording session');
                startSpeechDetection();
            }
            $('#record-toggle').addClass('hidden');

            isRunning = true;
            timer = setInterval(() => {
                if (timeLeft > 0) {
                    timeLeft--;
                    updateDisplay();
                } else {
                    clearInterval(timer);
                    triggerWin();
                }
            }, 1000);
            return;
        }

        // State 3: RUNNING -> Pause
        if (isRunning) {
            clearInterval(timer);
            isRunning = false;
            $btn.text('Resume');
            $('.time-adjust').prop('disabled', false);
            if (mediaRecorder?.state === 'recording') mediaRecorder.pause();
            return;
        }

        // State 4: PAUSED -> Resume
        if (!isRunning && $btn.text() === 'Resume') {
            $btn.text('Pause');
            isRunning = true;
            $('.time-adjust').prop('disabled', true);
            $('#time-plus, #time-minus').addClass('hidden');
            $('#btn-reset-icon').addClass('active').prop('disabled', false);
            if (mediaRecorder?.state === 'paused') mediaRecorder.resume();
            
            timer = setInterval(() => {
                if (timeLeft > 0) {
                    timeLeft--;
                    updateDisplay();
                } else {
                    clearInterval(timer);
                    triggerWin();
                }
            }, 1000);
            return;
        }
    });

    async function triggerWin() {
        sessionDuration = sessionTotalTime;
        sessionDate = new Date();
        
        stopSpeechDetection();
        let url = null;
        if (recordingEnabled && mediaRecorder) {
            url = await stopRecording();
        } else {
            stopMicStream();
        }
        
        // Always show report after 1s delay to allow "Aura" message to be seen
        setTimeout(() => showPostSession(url), 1000);

        const phrases = [
            "Aura +10",
            "Maximum Aura Attained",
            "Total Glow Up",
            "Main Character Energy",
            "Radiant Performance",
            "Elegance Level Up",
            "Front Page Worthy",
            "Voice Refined",
            "Cognitive Flow State",
            "Absolute Clarity",
            "Speech Polished",
            "Neural Pathways Ignited",
            "Iconic Energy"
        ];
        const randomPhrase = phrases[Math.floor(Math.random() * phrases.length)];
        const $winMsg = $('#win-message');
        $winMsg.text(randomPhrase).removeClass('fade-out').addClass('show');

        if (winTimeout) { clearTimeout(winTimeout); winTimeout = null; }
        
        // Background Pulse (1.5s)
        $('.canvas').addClass('bloom');
        setTimeout(() => {
            $('.canvas').removeClass('bloom');
        }, 1500);

        // Message Visibility (4s total)
        winTimeout = setTimeout(() => {
            $winMsg.addClass('fade-out');
            setTimeout(() => {
                $winMsg.removeClass('show fade-out');
                winTimeout = null;
            }, 500);
        }, 3500);

        // Auto-load next topic after win
        getNewTopic(true);
        $('#btn-main').text('Start Speaking');
        $('#btn-reroll').addClass('active');
        
        // Reset timer for next round
        timeLeft = parseInt(localStorage.getItem('speechSessionTimer')) || 60;
        updateDisplay(true);
        $('#timer-display').removeClass('active');

        $('.time-adjust').prop('disabled', false);
        $('#time-plus, #time-minus').removeClass('hidden'); $('#btn-reset-icon').removeClass('active');
        isRunning = false;
        topicSelected = true;
        clearStepDisplay();
        $('#record-toggle').removeClass('hidden').find('span:last-child').text('Record session');
    }

    function clearRecordingBlob() {
        if (recObjectUrl) { URL.revokeObjectURL(recObjectUrl); recObjectUrl = null; }
        audioBlob = null;
        recordedChunks = [];
    }

    $('#btn-reset-icon').click(function() {
        clearInterval(timer);
        if (winTimeout) { clearTimeout(winTimeout); winTimeout = null; }
        stopSpeechDetection();
        stopMicStream();
        if (mediaRecorder && mediaRecorder.state !== 'inactive') { mediaRecorder.stop(); mediaRecorder = null; }
        clearRecordingBlob();
        isRunning = false;
        $('.canvas').removeClass('bloom');
        $('#btn-main').text('Start Speaking');
        $('#btn-reroll').addClass('active');
        timeLeft = parseInt(localStorage.getItem('speechSessionTimer')) || 60;
        updateDisplay(true);
        $('.time-adjust').prop('disabled', false);
        $('#time-plus, #time-minus').removeClass('hidden'); $(this).removeClass('active');
        $('#timer-display').removeClass('active');
        clearStepDisplay();
        $('#record-toggle').removeClass('hidden').find('span:last-child').text('Record session');
    });

    // --- Recording ---

    $('#record-toggle').click(async function() {
        if (isRunning || $(this).hasClass('disabled')) return;
        
        if (!recordingEnabled) {
            try {
                // Trigger permission prompt immediately
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                stream.getTracks().forEach(t => t.stop()); 
                recordingEnabled = true;
            } catch (e) {
                console.error("Mic permission denied", e);
                recordingEnabled = false;
            }
        } else {
            recordingEnabled = false;
        }
        $(this).toggleClass('active', recordingEnabled);
    });

    async function startRecording() {
        try {
            micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

            // MediaRecorder
            recordedChunks = [];
            const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
            mediaRecorder = new MediaRecorder(micStream, mimeType ? { mimeType } : {});
            mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
            mediaRecorder.start();

            // Energy analyser (speech band: 300–3400 Hz)
            audioContext = new AudioContext();
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;
            audioContext.createMediaStreamSource(micStream).connect(analyser);
            const dataArray = new Uint8Array(analyser.frequencyBinCount);
            const binWidth = audioContext.sampleRate / analyser.fftSize;
            const lowBin = Math.max(0, Math.floor(300 / binWidth));
            const highBin = Math.min(analyser.frequencyBinCount - 1, Math.ceil(3400 / binWidth));
            energySamples = [];
            sampleInterval = setInterval(() => {
                analyser.getByteFrequencyData(dataArray);
                const slice = dataArray.slice(lowBin, highBin + 1);
                const avg = slice.reduce((a, b) => a + b) / slice.length;
                energySamples.push(avg);
            }, 200);
        } catch (e) {
            recordingEnabled = false;
            $('#record-toggle').removeClass('active');
            mediaRecorder = null;
            micStream = null;
        }
    }

    function stopRecording() {
        return new Promise(resolve => {
            if (!mediaRecorder || mediaRecorder.state === 'inactive') { resolve(null); return; }
            mediaRecorder.onstop = () => {
                audioBlob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
                if (recObjectUrl) URL.revokeObjectURL(recObjectUrl);
                recObjectUrl = URL.createObjectURL(audioBlob);
                stopMicStream();
                mediaRecorder = null;
                resolve(recObjectUrl);
            };
            if (mediaRecorder.state === 'paused') mediaRecorder.resume();
            mediaRecorder.stop();
        });
    }

    function stopMicStream() {
        if (sampleInterval) { clearInterval(sampleInterval); sampleInterval = null; }
        if (audioContext) { audioContext.close(); audioContext = null; analyser = null; }
        if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    }

    function startSpeechDetection() {
        if (!speechApiSupported) return;
        speechDetected = false;
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        speechRecognition = new SR();
        speechRecognition.continuous = true;
        speechRecognition.interimResults = true;
        let recognizedWords = 0;
        speechRecognition.onresult = (e) => {
            for (let i = e.resultIndex; i < e.results.length; i++) {
                const words = e.results[i][0].transcript.trim().split(/\s+/).filter(w => w.length > 0);
                recognizedWords += words.length;
            }
            if (recognizedWords >= 5) speechDetected = true;
        };
        speechRecognition.onerror = () => {};
        speechRecognition.onend = () => { if (isRunning) try { speechRecognition.start(); } catch(e) {} };
        try { speechRecognition.start(); } catch(e) {}
    }

    function stopSpeechDetection() {
        if (!speechRecognition) return;
        speechRecognition.onend = null;
        try { speechRecognition.stop(); } catch(e) {}
        speechRecognition = null;
    }

    function generateObservations(samples) {
        if (samples.length < 3) return [];
        const obs = [];
        const avg = samples.reduce((a, b) => a + b) / samples.length;

        // Opening energy
        const openSlice = samples.slice(0, Math.min(10, samples.length));
        const openAvg = openSlice.reduce((a, b) => a + b) / openSlice.length;
        obs.push(openAvg >= avg * 1.2
            ? 'Strong opening — good energy in the first few seconds.'
            : 'Quiet opening — try projecting more from the start.');

        // Flat section
        const threshold = avg * 0.6;
        let flatRun = { start: 0, len: 0 };
        let cur = { start: 0, len: 0 };
        samples.forEach((s, i) => {
            if (s < threshold) {
                if (cur.len === 0) cur.start = i;
                cur.len++;
                if (cur.len > flatRun.len) flatRun = { ...cur };
            } else {
                cur = { start: 0, len: 0 };
            }
        });
        if (flatRun.len > 5) {
            const ts = (flatRun.start * 0.2).toFixed(0);
            obs.push(`Energy dipped around ${ts}s — try emphasising key words there.`);
        }

        // Closing energy
        const closeSlice = samples.slice(-Math.min(10, samples.length));
        const closeAvg = closeSlice.reduce((a, b) => a + b) / closeSlice.length;
        obs.push(closeAvg >= avg
            ? 'Good energy toward the end — strong finish.'
            : 'Energy dropped at the end — make sure your conclusion lands.');

        // Overall variance
        const variance = samples.reduce((sum, s) => sum + (s - avg) ** 2, 0) / samples.length;
        if (variance < 200) {
            obs.push('Your delivery was quite flat overall — aim for more peaks and valleys.');
        }

        return obs;
    }

    // Analysis Report State
    let fillerTally = 0;
    let sessionRating = 0;

    function showPostSession(url) {
        // Hide main UI
        $('#main-sidebar, main > div > div.canvas').fadeOut(400);
        
        // Populate Report
        $('#report-topic-text').text($('#topic-text').text().trim());
        const dateStr = sessionDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
        const mins = Math.floor(sessionDuration / 60);
        const secs = sessionDuration % 60;
        const goal = $('.goal-check:checked').parent().text().trim();
        $('#report-meta-text').text(`${dateStr} • ${mins > 0 ? mins + 'm ' : ''}${secs}s • ${goal} GOAL`);

        // Audio Setup
        const $audio = $('#report-audio')[0];
        $audio.src = url || '';
        $audio.onended = () => {
            $('#btn-play-report i').attr('data-lucide', 'play');
            lucide.createIcons();
        };

        // Visibility based on recording
        $('.waveform-container').toggle(!!url);
        $('#btn-report-download').toggle(!!url);
        
        const speechOk = !speechApiSupported || speechDetected;

        // Hide Filler card
        $('.insight-label').filter(function() {
            return $(this).text() === 'Filler Moments';
        }).closest('.insight-card').toggle(!!url && speechOk);

        // Hide Vocal Observations Panel (the entire column)
        $('.insight-label').filter(function() {
            return $(this).text() === 'Vocal Observations';
        }).closest('.report-panel').toggle(!!url);

        // Observations
        if (url && speechOk) {
            const obs = generateObservations(energySamples);
            $('#report-observations').html(obs.map(o => `<div class="observation-item">${o}</div>`).join(''));
        } else if (url && !speechOk) {
            $('#report-observations').html('<div class="observation-item">No speech was detected in this recording. Make sure your microphone is working and that you spoke loud enough during the session.</div>');
        } else {
            $('#report-observations').empty();
        }
        
        // Reset states
        fillerTally = 0;
        sessionRating = 0;
        $('#filler-tally-val').text('0');
        $('.orb').removeClass('active');
        $('.eval-check').prop('checked', false);

        // Show Report
        setTimeout(() => {
            $('body').addClass('report-open');
            $('#analysis-report').addClass('show');
            if (url) renderReportWaveform(energySamples);
            lucide.createIcons();
        }, 400);
    }

    function renderReportWaveform(samples) {
        const canvas = document.getElementById('report-waveform');
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.offsetWidth;
        const h = canvas.offsetHeight;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);

        const draw = () => {
            ctx.clearRect(0, 0, w, h);
            if (!samples.length) return;

            const avg = samples.reduce((a, b) => a + b) / samples.length;
            const threshold = avg * 0.6;
            const barW = Math.max(2, (w / samples.length) - 2);
            const gap = w / samples.length;
            const maxAmplitude = 255;

            samples.forEach((s, i) => {
                const barH = Math.max(4, (s / maxAmplitude) * h);
                const x = i * gap;
                const y = (h - barH) / 2;
                
                // Highlight based on current playback
                const $audio = $('#report-audio')[0];
                const progress = $audio.currentTime / $audio.duration;
                const isPlayed = (i / samples.length) <= progress;

                ctx.fillStyle = isPlayed ? '#7000ff' : 'rgba(112, 0, 255, 0.15)';
                ctx.beginPath();
                ctx.roundRect(x, y, barW, barH, 2);
                ctx.fill();
            });

            // Scrubber line
            const $audio = $('#report-audio')[0];
            if ($audio.duration) {
                const progress = $audio.currentTime / $audio.duration;
                ctx.strokeStyle = '#7000ff';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(progress * w, 0);
                ctx.lineTo(progress * w, h);
                ctx.stroke();
            }

            if (!$audio.paused) requestAnimationFrame(draw);
        };
        draw();

        // Seek interaction
        canvas.onclick = (e) => {
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const progress = x / rect.width;
            const $audio = $('#report-audio')[0];
            if ($audio.duration) {
                $audio.currentTime = progress * $audio.duration;
                draw();
            }
        };
    }

    $('#btn-play-report').click(function() {
        const $audio = $('#report-audio')[0];
        const $icon = $(this).find('i');
        if ($audio.paused) {
            $audio.play();
            $icon.attr('data-lucide', 'pause');
            renderReportWaveform(energySamples);
        } else {
            $audio.pause();
            $icon.attr('data-lucide', 'play');
        }
        lucide.createIcons();
    });

    $('#btn-tally-add').click(function() {
        fillerTally++;
        $('#filler-tally-val').text(fillerTally);
    });

    $('.orb').click(function() {
        const val = parseInt($(this).data('value'));
        sessionRating = val;
        $('.orb').each(function() {
            $(this).toggleClass('active', parseInt($(this).data('value')) <= val);
        });
    });

    $('#btn-report-export').click(exportPDF);
    $('#btn-report-download').click(function() {
        if (!recObjectUrl || !audioBlob) return;
        const a = document.createElement('a');
        a.href = recObjectUrl;
        const ext = (audioBlob.type.includes('ogg') ? 'ogg' : (audioBlob.type.includes('mp4') ? 'mp4' : 'webm'));
        a.download = `speechlab-${new Date().toISOString().slice(0,10)}.${ext}`;
        a.click();
    });

    $('#btn-next-session').click(function() {
        $('body').removeClass('report-open');
        $('#analysis-report').removeClass('show');
        $('main > div > div.canvas').fadeIn(400);

        // Full Reset
        const $audio = $('#report-audio')[0];
        $audio.pause();
        $audio.src = '';
        clearRecordingBlob();
        getNewTopic(true);
        $('#btn-main').text('Start Speaking');
        timeLeft = parseInt(localStorage.getItem('speechSessionTimer')) || 60;
        updateDisplay(true);
    });

    function exportPDF() {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ unit: 'mm', format: 'a4' });
        const margin = 20;
        const contentW = 170;
        let y = 22;

        function checkBreak(needed) {
            if (y + needed > 275) { doc.addPage(); y = 20; }
        }

        function sectionLabel(text) {
            checkBreak(10);
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(7);
            doc.setTextColor(136, 136, 136);
            doc.text(text, margin, y);
            y += 5;
        }

        // Title
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(20);
        doc.setTextColor(26, 26, 26);
        doc.text('SpeechLab Session Report', margin, y);
        y += 10;

        // Meta
        const dateStr = sessionDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
        const mins = Math.floor(sessionDuration / 60);
        const secs = sessionDuration % 60;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.text(`${dateStr}  •  ${mins > 0 ? mins + 'm ' : ''}${secs}s Duration`, margin, y);
        y += 8;

        doc.setDrawColor(240, 240, 240);
        doc.line(margin, y, margin + contentW, y);
        y += 10;

        // Topic
        sectionLabel('PRACTICE TOPIC');
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(14);
        doc.setTextColor(26, 26, 26);
        const topicText = $('#report-topic-text').text().trim();
        const topicLines = doc.splitTextToSize(topicText, contentW);
        doc.text(topicLines, margin, y);
        y += topicLines.length * 7 + 10;

        // Metrics Row
        sectionLabel('PERFORMANCE METRICS');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.setTextColor(26, 26, 26);
        
        const audioRecorded = $('.waveform-container').is(':visible');
        if (audioRecorded) {
            doc.text(`Filler Moments: ${fillerTally}`, margin, y);
            doc.text('Session Performance:', margin + 60, y);
        } else {
            doc.text('Session Performance:', margin, y);
        }
        
        const orbRadius = 1.5;
        const orbGap = 5;
        let orbX = audioRecorded ? margin + 105 : margin + 45;
        for(let i=1; i<=5; i++) {
            if (i <= sessionRating) {
                doc.setDrawColor(112, 0, 255);
                doc.setFillColor(112, 0, 255);
                doc.circle(orbX, y - 1, orbRadius, 'FD');
            } else {
                doc.setDrawColor(200, 200, 200);
                doc.circle(orbX, y - 1, orbRadius, 'S');
            }
            orbX += orbGap;
        }
        y += 12;

        // Waveform
        const canvas = document.getElementById('report-waveform');
        if (audioRecorded && canvas.width > 0) {
            sectionLabel('VOCAL ENERGY MAP');
            const imgData = canvas.toDataURL('image/png');
            const imgH = 25;
            doc.addImage(imgData, 'PNG', margin, y, contentW, imgH);
            y += imgH + 12;
        }

        // Observations
        const obsTexts = [];
        $('.observation-item').each(function() { obsTexts.push($(this).text().trim()); });
        if (audioRecorded && obsTexts.length) {
            sectionLabel('VOCAL OBSERVATIONS');
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(9);
            obsTexts.forEach(text => {
                const lines = doc.splitTextToSize('• ' + text, contentW);
                checkBreak(lines.length * 5 + 2);
                doc.text(lines, margin, y);
                y += lines.length * 5 + 2;
            });
            y += 5;
        }

        // Self-evaluation
        sectionLabel('SELF-EVALUATION');
        $('.eval-item').each(function() {
            const checked = $(this).find('input').prop('checked');
            const label = $(this).find('.eval-label').text().trim();
            checkBreak(6);
            doc.text((checked ? '[x] ' : '[ ] ') + label, margin, y);
            y += 5;
        });

        doc.save(`speechlab-report-${new Date().toISOString().slice(0,10)}.pdf`);
    }

    function renderWaveform(samples) {
        // Deprecated - replaced by renderReportWaveform
    }

    $(document).on('click', '.filler-btn', function() {
        // Deprecated
    });

    $('#filler-reset').click(function() {
        // Deprecated
    });

    $('#btn-close-post-session').click(function() {
        // Deprecated
    });

    updateDisplay();
    updateMobileFilterDisplay();
});
