#!/bin/bash
# Quick command to generate and send briefing on demand

echo "🚀 Generating and sending news briefing..."
echo ""

cd /workspace/group/nanoclaw-skills/news-briefing
python3 main.py

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ SUCCESS! Briefing generated and sent to WhatsApp"
    echo ""
    echo "📱 Check your WhatsApp for the PDF"
    echo "📁 PDF also saved to: reports/briefing_$(date +%Y-%m-%d).pdf"
else
    echo ""
    echo "❌ ERROR: Briefing generation failed"
    echo "Check the output above for details"
fi
