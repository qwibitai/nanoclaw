#!/usr/bin/env python3
"""
Main Execution Script - News Briefing System
Orchestrates the complete briefing generation and delivery process
"""

import json
import sys
import time
import subprocess
from pathlib import Path
from datetime import datetime
from typing import Dict, Any

# Add current directory to path
sys.path.append(str(Path(__file__).parent))

from orchestrator import NewsBriefingOrchestrator
from compile_briefing import BriefingCompiler
from generate_pdf import PDFGenerator


class NewsBriefingSystem:
    """Main system coordinator"""

    def __init__(self, base_dir: str = "/workspace/group/nanoclaw-skills/news-briefing"):
        self.base_dir = Path(base_dir)
        self.orchestrator = NewsBriefingOrchestrator(base_dir)
        self.compiler = BriefingCompiler(base_dir)
        self.pdf_generator = PDFGenerator(base_dir)

    def run_full_briefing(self) -> str:
        """Execute complete briefing generation pipeline"""

        print("=" * 70)
        print("📰 DAILY NEWS BRIEFING SYSTEM")
        print("=" * 70)
        print(f"Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print()

        try:
            # Step 1: Orchestration
            print("STEP 1: Orchestration & Task Generation")
            print("-" * 70)
            preferences = self.orchestrator.load_user_preferences()
            memory = self.orchestrator.load_memory()
            tasks = self.orchestrator.create_research_tasks(preferences)

            print(f"✓ Loaded {len(preferences['categories'])} categories")
            print(f"✓ Tracking {len(memory.get('seen_articles', []))} seen articles")
            print(f"✓ Created {len(tasks)} research tasks")
            print()

            # Step 2: Research Execution
            print("STEP 2: Multi-Agent Research Execution")
            print("-" * 70)
            print(f"Deploying {len(tasks)} parallel research agents...")
            print("⚠️  NOTE: For PoC, agents were pre-executed. In production,")
            print("   this would use TeamCreate to spawn agents in real-time.")

            # Check if results exist
            results_dir = self.base_dir / "agents" / "results"
            result_files = list(results_dir.glob("result_*.json"))

            if len(result_files) < len(tasks):
                print(f"\n⚠️  WARNING: Only {len(result_files)} of {len(tasks)} results found!")
                print("   Please ensure all research agents have completed.")
                return "incomplete"

            print(f"✓ All {len(result_files)} research results ready")
            print()

            # Step 3: Compilation & Deduplication
            print("STEP 3: Compilation & Deduplication")
            print("-" * 70)
            results = self.compiler.load_all_research_results()
            deduplicated_results = self.compiler.deduplicate_articles(results, memory)
            briefing = self.compiler.compile_final_briefing(deduplicated_results)

            briefing_file = self.compiler.save_briefing(briefing)
            self.orchestrator.update_memory_with_briefing(briefing, memory)
            self.orchestrator.save_memory(memory)

            total_articles = sum(len(r.get("articles", [])) for r in deduplicated_results)
            print(f"✓ Compiled {total_articles} unique articles")
            print(f"✓ Saved briefing: {Path(briefing_file).name}")
            print(f"✓ Updated memory")
            print()

            # Step 4: PDF Generation
            print("STEP 4: PDF Generation")
            print("-" * 70)
            template = self.pdf_generator.load_template()
            html = self.pdf_generator.render_briefing(briefing, template)

            date = briefing.get("metadata", {}).get("date", datetime.now().strftime("%Y-%m-%d"))
            html_file = self.pdf_generator.reports_dir / f"briefing_{date}.html"
            pdf_file = self.pdf_generator.reports_dir / f"briefing_{date}.pdf"

            self.pdf_generator.save_html(html, str(html_file))
            print(f"✓ Generated HTML: {html_file.name}")

            # Generate PDF using agent-browser
            result = subprocess.run(
                ["agent-browser", "open", f"file://{html_file}"],
                capture_output=True,
                text=True
            )

            if result.returncode == 0:
                result = subprocess.run(
                    ["agent-browser", "pdf", str(pdf_file)],
                    capture_output=True,
                    text=True
                )

                subprocess.run(["agent-browser", "close"], capture_output=True)

                if pdf_file.exists():
                    pdf_size = pdf_file.stat().st_size / 1024  # KB
                    print(f"✓ Generated PDF: {pdf_file.name} ({pdf_size:.1f} KB)")
                else:
                    print("✗ PDF generation failed")
                    return "error"
            else:
                print("✗ Browser open failed")
                return "error"

            print()

            # Step 5: WhatsApp Delivery
            print("STEP 5: WhatsApp Delivery")
            print("-" * 70)

            caption = self._generate_caption(briefing)

            # chatJid and groupFolder are set during skill installation (see SKILL.md)
            chat_jid = os.environ.get("NANOCLAW_CHAT_JID", "YOUR_CHAT_JID_HERE")
            group_folder = os.environ.get("NANOCLAW_GROUP_FOLDER", "main")

            ipc_message = {
                "type": "file",
                "chatJid": chat_jid,
                "file_path": str(pdf_file),
                "caption": caption,
                "groupFolder": group_folder,
                "timestamp": datetime.now().isoformat()
            }

            # Write to IPC directory
            ipc_file = Path("/workspace/ipc/messages") / f"briefing_{int(time.time())}.json"
            with open(ipc_file, 'w') as f:
                json.dump(ipc_message, f, indent=2)

            print(f"✓ Queued for delivery: {pdf_file.name}")
            print(f"✓ IPC message created")
            print()

            # Summary
            print("=" * 70)
            print("✅ BRIEFING GENERATION COMPLETE")
            print("=" * 70)
            print(f"Date: {date}")
            print(f"Articles: {briefing['summary']['total_articles']}")
            print(f"Sources: {len(briefing['summary']['sources'])}")
            print(f"PDF: {pdf_file}")
            print(f"Delivery: Queued for WhatsApp")
            print()

            return "success"

        except Exception as e:
            print(f"\n❌ ERROR: {e}")
            import traceback
            traceback.print_exc()
            return "error"

    def _generate_caption(self, briefing: Dict[str, Any]) -> str:
        """Generate WhatsApp caption for briefing"""
        date = briefing.get("metadata", {}).get("date", "")
        formatted_date = datetime.strptime(date, "%Y-%m-%d").strftime("%B %d, %Y")
        total_articles = briefing['summary']['total_articles']
        total_categories = briefing['summary']['total_categories']
        sources_count = len(briefing['summary']['sources'])

        # Get top headlines from each category
        top_headlines = []
        for section in briefing['sections'][:2]:  # First 2 categories
            if section['articles']:
                top_article = section['articles'][0]
                top_headlines.append(top_article.get('title', 'Untitled'))

        caption = f"""📰 *Your Daily News Briefing*
{formatted_date}

📊 *Today's Brief:*
• {total_categories} categories covered
• {total_articles} top articles
• {sources_count} credible sources

🔥 *Top Headlines:*
"""

        for i, headline in enumerate(top_headlines[:3], 1):
            # Truncate long headlines
            if len(headline) > 80:
                headline = headline[:77] + "..."
            caption += f"{i}. {headline}\n"

        caption += "\n_Generated by AI News Briefing System_"

        return caption


def main():
    """Main entry point"""
    system = NewsBriefingSystem()
    result = system.run_full_briefing()

    if result == "success":
        sys.exit(0)
    else:
        sys.exit(1)


if __name__ == "__main__":
    main()
