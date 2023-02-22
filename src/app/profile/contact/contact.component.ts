import { Component, HostListener, Inject, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { HttpHeaders} from '@angular/common/http';
import { ProfileService } from '../profile.service';
import { SnotifyService } from 'ng-snotify';
import { environment } from '../../../environments/environment';
import { DOCUMENT } from '@angular/common';

@Component({
  selector: 'app-contact',
  templateUrl: './contact.component.html',
  styleUrls: ['./contact.component.scss']
})
  export class ContactComponent implements OnInit {
 
    model: any = {};
    windowScrolled: boolean;
    constructor(
      private http: HttpClient,@Inject(DOCUMENT) private document: Document
    ){}
    @HostListener("window:scroll", [])
    onWindowScroll() {
      if (window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop > 100) {
          this.windowScrolled = true;
      } 
     else if (this.windowScrolled && window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop < 10) {
          this.windowScrolled = false;
      }
  }
  scrollToTop() {
      (function smoothscroll() {
          var currentScroll = document.documentElement.scrollTop || document.body.scrollTop;
          if (currentScroll > 0) {
              window.requestAnimationFrame(smoothscroll);
              window.scrollTo(0, currentScroll - (currentScroll / 8));
          }
      })();
  }
    ngOnInit() {
       }
       onSubmit(name, subject, email, message) {
         debugger;
          const headers = new HttpHeaders({ 'Content-Type': 'application/json' });
          this.http.post('https://formspree.io/f/xbjpwrpp',
            { name: name, subject: subject, replyto: email, message: message },
            { 'headers': headers }).subscribe(
              response => {
                console.log(response);
              }
            );
        }  
}
