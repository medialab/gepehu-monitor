import os
import sys
import csv
import json


HEADERS = [
    "datetime",
    "gpu_name",
    "usage_percent",
    "memory",
    "memory_percent",
    "energy",
    "temperature",
    "fan_speed",
    "users",
    "processes"
]

def parse(filename):
    with open(filename) as f:
        data = json.load(f)

    for gpu in data["gpus"]:
        row = {
            "datetime": data["query_time"],
            "gpu_name": "%s #%s" % (gpu["name"], gpu["index"]),
            "usage_percent": gpu["utilization.gpu"],
            "memory": gpu["memory.used"],
            "memory_percent": 100 * gpu["memory.used"] / gpu["memory.total"],
            "energy": gpu["power.draw"],
            "temperature": gpu["temperature.gpu"],
            "fan_speed": gpu["fan.speed"],
            "users": "|".join([p["username"] for p in gpu["processes"]]),
            "processes": "|".join([" ".join(p["full_command"]) for p in gpu["processes"]])
        }

        csvfilename = os.path.join("data", "%s.csv" % gpu["uuid"])

        if not os.path.exists(csvfilename):
            with open(csvfilename, "w") as f:
                writer = csv.writer(f)
                writer.writerow(HEADERS)

        with open(csvfilename, "a") as f:
            writer = csv.writer(f)
            writer.writerow([row[h] for h in HEADERS])


if __name__ == "__main__":
    FILE = sys.argv[1]
    parse(FILE)
