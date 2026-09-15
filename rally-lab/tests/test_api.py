"""Real upload, decode, model inference, stream and MP4 export, on synthetic images.
Does not establish accuracy on badminton footage or a mobile network.
"""
import base64
import os
import tempfile
import time
import unittest
from pathlib import Path

os.environ['RALLY_DATA']=tempfile.mkdtemp(prefix='rally-api-')
os.environ['RALLY_ACCESS_CODE']='test-only-code'

import cv2
import numpy as np
from fastapi.testclient import TestClient
from backend.main import app


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client=TestClient(app)
        cls.client.post('/api/login',json={'code':'test-only-code'})
        cls.sid=cls.client.post('/api/sessions').json()['id']

    def test_auth_and_invalid_court(self):
        anon=TestClient(app)
        self.assertEqual(anon.get('/api/sessions').status_code,401)
        s=self.client.get('/api/sessions/'+self.sid).json()['settings']
        s['court']=[[.1,.1],[.9,.9],[.9,.1],[.1,.9]]
        self.assertEqual(self.client.put(f'/api/sessions/{self.sid}/settings',json=s).status_code,422)

    def test_websocket_real_blank_frame_roundtrip(self):
        _,jpg=cv2.imencode('.jpg',np.zeros((180,320,3),np.uint8))
        with self.client.websocket_connect('/ws/'+self.sid) as socket:
            socket.send_json({'seq':17,'source_time':1,'mode':'score','jpeg':base64.b64encode(jpg).decode()})
            r=socket.receive_json()
            self.assertEqual(r['seq'],17)
            self.assertIsNone(r['model_error'])
            self.assertEqual(r['score']['total_events'],0)
            self.assertGreater(r['processing_ms'],0)
            self.assertEqual(self.client.get(f'/api/sessions/{self.sid}/preview.jpg').status_code,200)

    def test_video_upload_analysis_edit_and_export(self):
        path=Path(os.environ['RALLY_DATA'])/'input.mp4'
        writer=cv2.VideoWriter(str(path),cv2.VideoWriter_fourcc(*'mp4v'),12,(320,180))
        self.assertTrue(writer.isOpened())
        for i in range(36):
            image=np.zeros((180,320,3),np.uint8)
            cv2.rectangle(image,(20+i,60),(70+i,120),(80,160,90),-1)
            writer.write(image)
        writer.release()
        with path.open('rb') as f:r=self.client.post('/api/videos?sid='+self.sid,files={'file':('input.mp4',f,'video/mp4')})
        self.assertEqual(r.status_code,200,r.text)
        ident=r.json()['id']
        job=self.wait_job(ident,'status',('done','error'))
        self.assertEqual(job['status'],'done',job)
        self.assertIsNone(job['model_error'])
        self.assertEqual(job['clips'],[]) # No fabricated rally in a no-person fixture.
        clips=[{'start':.2,'end':.8,'selected':True},{'start':1.2,'end':2.,'selected':True}]
        self.assertEqual(self.client.put(f'/api/videos/{ident}/clips',json={'clips':clips}).status_code,200)
        self.assertEqual(self.client.put(f'/api/videos/{ident}/clips',json={'clips':[{'start':2,'end':1}]}).status_code,422)
        self.assertEqual(self.client.post(f'/api/videos/{ident}/export').status_code,200)
        job=self.wait_job(ident,'export_status',('done','error'))
        self.assertEqual(job['export_status'],'done',job)
        data=self.client.get(f'/api/videos/{ident}/export')
        self.assertEqual(data.status_code,200)
        result=Path(os.environ['RALLY_DATA'])/'output.mp4';result.write_bytes(data.content)
        cap=cv2.VideoCapture(str(result));duration=cap.get(cv2.CAP_PROP_FRAME_COUNT)/cap.get(cv2.CAP_PROP_FPS);cap.release()
        self.assertAlmostEqual(duration,1.4,delta=.2)

    def wait_job(self,ident,key,states):
        deadline=time.monotonic()+60
        while time.monotonic()<deadline:
            job=self.client.get('/api/videos/'+ident).json()
            if job.get(key) in states:return job
            time.sleep(.15)
        self.fail('Job timed out')


if __name__=='__main__':unittest.main()
