import os
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

OPENAI_API_BASE = os.getenv('OPENAI_API_BASE', 'https://api.openai.com/v1')
OPENAI_API_KEY = os.getenv('OPENAI_API_KEY', '')
OPENAI_MODEL = os.getenv('OPENAI_MODEL', 'gpt-4o-mini')
CONCURRENCY = int(os.getenv('CONCURRENCY', '5'))
REQUEST_DELAY_MS = int(os.getenv('REQUEST_DELAY_MS', '1000'))

DATA_DIR = os.path.join(os.path.dirname(__file__), '..', 'data')
SCHOOLS_FILE = os.path.join(DATA_DIR, 'schools.json')
RESULTS_FILE = os.path.join(DATA_DIR, 'results.json')
PDF_DIR = os.path.join(DATA_DIR, 'pdfs')
