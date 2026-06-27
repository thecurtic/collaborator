import os
os.environ["AUTH_ENABLED"] = "false"

print("Before importing main")
from main import app, config
print(f"After importing main")

import os.path
db_path = config['memory']['db_path']
print(f"DB path: {db_path}")
print(f"File exists at config path: {os.path.exists(db_path)}")

from db import _db_path
print(f"Resolved DB path: {_db_path()}")
print(f"File exists at resolved path: {os.path.exists(_db_path())}")

import sqlite3
conn = sqlite3.connect(_db_path())
cursor = conn.cursor()
cursor.execute("CREATE TABLE IF NOT EXISTS test (id INTEGER)")
conn.commit()
print("Table created")
conn.close()

from fastapi.testclient import TestClient
client = TestClient(app)
response = client.get('/api/messages')
print(f"Status: {response.status_code}")
