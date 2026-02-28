"""列出 schools.json 中所有学校名称"""
import json

with open(r'd:\LocalRepo\CollegeFinder\data\schools.json', 'r', encoding='utf-8') as f:
    schools = json.load(f)

names = sorted(set(s['name'] for s in schools))
with open(r'd:\LocalRepo\CollegeFinder\data\school_names.txt', 'w', encoding='utf-8') as f:
    for n in names:
        f.write(n + '\n')

print(f"共 {len(names)} 个不重复学校名")
